package com.obsoloom.camera;

import android.net.LocalServerSocket;
import android.net.LocalSocket;
import android.net.LocalSocketAddress;
import android.util.Log;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.LinkedBlockingQueue;

/**
 * Serves the encoded camera stream to one PC client at a time.
 *
 * The stream is served on a Unix-domain socket, not TCP, so nothing on any
 * network can reach it and the app needs no network permission. Other apps on
 * the phone could still open that socket, so every connection's kernel-
 * reported uid is checked: only adb's shell user (the PC, via adb forward
 * over USB) is let in. Anything else is closed before it sees a byte.
 *
 * Wire format, phone to PC, one packet after another:
 *
 *   byte   type      1 = codec config (SPS/PPS), 2 = video frame, 3 = JSON info
 *   byte   flags     bit 0 = keyframe
 *   short  reserved
 *   long   ptsUs     presentation time, microseconds, big-endian
 *   int    length    payload bytes, big-endian
 *   byte[] payload   H.264 in Annex-B form, or UTF-8 JSON
 *
 * PC to phone is newline-delimited JSON, handed to the listener as-is.
 */
final class StreamServer {
    private static final String TAG = "Obsoloom";

    static final byte TYPE_CONFIG = 1;
    static final byte TYPE_FRAME = 2;
    static final byte TYPE_INFO = 3;

    interface Listener {
        /** A client connected or went away. */
        void onClientChanged(boolean connected);

        /** The client needs a keyframe to start (or restart) decoding. */
        void onKeyframeWanted();

        /** One line of control JSON from the client. */
        void onControl(String json);
    }

    /** adb's shell user: connections forwarded from the PC arrive as this uid. */
    private static final int SHELL_UID = 2000;

    private final String name;
    private final Listener listener;
    private final Object lock = new Object();

    private volatile boolean running;
    private LocalServerSocket serverSocket;
    private Client client;
    private byte[] config;
    private String info = "{}";

    StreamServer(String name, Listener listener) {
        this.name = name;
        this.listener = listener;
    }

    void start() {
        running = true;
        Thread t = new Thread(this::acceptLoop, "obsoloom-accept");
        t.setDaemon(true);
        t.start();
    }

    void stop() {
        running = false;
        synchronized (lock) {
            if (client != null) client.close();
            client = null;
        }
        try {
            if (serverSocket != null) serverSocket.close();
        } catch (IOException ignored) {
            // closing anyway
        }
        // Closing a LocalServerSocket does not wake a thread blocked in
        // accept(), and the name stays taken until it returns: connect once
        // so it does. (That connection is not the shell user, so it is refused.)
        try (LocalSocket wake = new LocalSocket()) {
            wake.connect(new LocalSocketAddress(name));
        } catch (IOException ignored) {
            // already gone
        }
    }

    boolean hasClient() {
        synchronized (lock) {
            return client != null;
        }
    }

    /** SPS/PPS. Kept so a client that connects later can still start decoding. */
    void setConfig(byte[] data) {
        synchronized (lock) {
            config = data;
            if (client != null) client.offer(packet(TYPE_CONFIG, 0, 0, data), true);
        }
    }

    /** Stream description (size, fps, camera), sent to each client first. */
    void setInfo(String json) {
        synchronized (lock) {
            info = json;
            if (client != null) {
                client.offer(packet(TYPE_INFO, 0, 0, json.getBytes(StandardCharsets.UTF_8)), true);
            }
        }
    }

    void sendFrame(byte[] data, long ptsUs, boolean keyframe) {
        Client c;
        synchronized (lock) {
            c = client;
        }
        if (c == null) return;

        // A client that fell behind has lost frames, and H.264 cannot resume
        // mid-stream: skip ahead to the next keyframe rather than send
        // frames it has no way to decode.
        if (c.waitingForKeyframe) {
            if (!keyframe) return;
            c.waitingForKeyframe = false;
        }
        if (!c.offer(packet(TYPE_FRAME, keyframe ? 1 : 0, ptsUs, data), false)) {
            c.waitingForKeyframe = true;
            listener.onKeyframeWanted();
        }
    }

    private static byte[] packet(byte type, int flags, long ptsUs, byte[] payload) {
        ByteBuffer b = ByteBuffer.allocate(16 + payload.length);
        b.put(type);
        b.put((byte) flags);
        b.putShort((short) 0);
        b.putLong(ptsUs);
        b.putInt(payload.length);
        b.put(payload);
        return b.array();
    }

    private void acceptLoop() {
        try {
            serverSocket = new LocalServerSocket(name);
            Log.i(TAG, "listening on @" + name);
            while (running) {
                LocalSocket socket = serverSocket.accept();
                if (!running) {
                    socket.close();
                    break;
                }
                int uid;
                try {
                    uid = socket.getPeerCredentials().getUid();
                } catch (IOException e) {
                    uid = -1;
                }
                if (uid != SHELL_UID) {
                    Log.w(TAG, "refused a connection from uid " + uid);
                    socket.close();
                    continue;
                }
                Client next = new Client(socket);
                synchronized (lock) {
                    if (client != null) client.close();
                    client = next;
                    next.offer(packet(TYPE_INFO, 0, 0, info.getBytes(StandardCharsets.UTF_8)), true);
                    if (config != null) next.offer(packet(TYPE_CONFIG, 0, 0, config), true);
                }
                next.start();
                Log.i(TAG, "client connected");
                listener.onClientChanged(true);
                listener.onKeyframeWanted();
            }
        } catch (IOException e) {
            if (running) Log.e(TAG, "server stopped: " + e);
        }
    }

    private void clientGone(Client c) {
        boolean was;
        synchronized (lock) {
            was = client == c;
            if (was) client = null;
        }
        c.close();
        if (was) {
            Log.i(TAG, "client disconnected");
            listener.onClientChanged(false);
        }
    }

    private final class Client {
        private final LocalSocket socket;
        // About three seconds of video at 30fps: enough to ride out a hiccup,
        // small enough that latency cannot quietly build up behind it.
        private final LinkedBlockingQueue<byte[]> queue = new LinkedBlockingQueue<>(90);
        volatile boolean waitingForKeyframe = true;
        private volatile boolean closed;

        Client(LocalSocket socket) {
            this.socket = socket;
        }

        boolean offer(byte[] packet, boolean must) {
            if (closed) return false;
            if (queue.offer(packet)) return true;
            if (must) {
                queue.clear();
                waitingForKeyframe = true;
                return queue.offer(packet);
            }
            return false;
        }

        void start() {
            Thread writer = new Thread(this::writeLoop, "obsoloom-write");
            writer.setDaemon(true);
            writer.start();
            Thread reader = new Thread(this::readLoop, "obsoloom-read");
            reader.setDaemon(true);
            reader.start();
        }

        private void writeLoop() {
            try {
                OutputStream out = socket.getOutputStream();
                while (!closed) {
                    out.write(queue.take());
                }
            } catch (IOException | InterruptedException e) {
                // the client went away
            }
            clientGone(this);
        }

        private void readLoop() {
            try {
                BufferedReader in = new BufferedReader(
                        new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
                String line;
                while (!closed && (line = in.readLine()) != null) {
                    if (!line.isEmpty()) listener.onControl(line);
                }
            } catch (IOException e) {
                // the client went away
            }
            clientGone(this);
        }

        void close() {
            closed = true;
            try {
                socket.close();
            } catch (IOException ignored) {
                // closing anyway
            }
        }
    }
}
