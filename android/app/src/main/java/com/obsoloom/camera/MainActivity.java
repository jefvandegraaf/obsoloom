package com.obsoloom.camera;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.hardware.camera2.CameraAccessException;
import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CameraDevice;
import android.hardware.camera2.CameraManager;
import android.hardware.camera2.CameraMetadata;
import android.hardware.camera2.CaptureRequest;
import android.hardware.camera2.params.OutputConfiguration;
import android.hardware.camera2.params.SessionConfiguration;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaFormat;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Log;
import android.util.Range;
import android.util.Rational;
import android.view.Gravity;
import android.view.OrientationEventListener;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.Iterator;
import java.util.List;

/**
 * Camera -> hardware H.264 encoder -> StreamServer.
 *
 * The camera writes straight into the encoder's input surface, so frames go
 * from sensor to compressed bitstream without ever being copied through this
 * process. Everything runs only while the activity is in the foreground.
 *
 * The PC drives the camera: control messages arrive as JSON lines, are kept
 * in {@link #controls}, and are applied to the repeating capture request.
 */
public class MainActivity extends Activity implements StreamServer.Listener {
    private static final String TAG = "Obsoloom";

    /** The abstract socket the PC reaches through `adb forward ... localabstract:`. */
    static final String SOCKET = "obsoloom-camera";
    static final int WIDTH = 1920;
    static final int HEIGHT = 1080;
    static final int FPS = 30;
    static final int BITRATE = 16_000_000;

    private FrameLayout root;
    private SurfaceView preview;
    private TextView status;

    private HandlerThread cameraThread;
    private Handler cameraHandler;
    private HandlerThread encoderThread;
    private Handler encoderHandler;

    private CameraDevice camera;
    private CameraCaptureSession session;
    private CaptureRequest.Builder request;
    private CameraCharacteristics characteristics;
    private MediaCodec encoder;
    private Surface encoderSurface;
    private StreamServer server;

    // Which camera to open: "0" is the main rear camera, "1" the front one.
    private String cameraId = "0";

    // What the PC has asked for. Survives a camera switch; absent keys mean
    // "leave it to the camera".
    private JSONObject controls = new JSONObject();

    private boolean previewReady;
    private boolean running;
    private long framesSent;

    private OrientationEventListener orientationListener;
    private int sensorOrientation = 90;
    private boolean facingFront;
    // How the phone is being held, snapped to a quarter turn. Starts at 270
    // (landscape, top edge to the left), the usual way round in a holder; a
    // phone lying flat reports nothing, and then the last known value stands.
    private int deviceOrientation = 270;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        String wanted = getIntent().getStringExtra("camera");
        if (wanted != null && !wanted.isEmpty()) cameraId = wanted;

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        // The PC starts this app over USB; it should come up even if the
        // phone happens to be locked on its stand.
        setShowWhenLocked(true);
        setTurnScreenOn(true);

        orientationListener = new OrientationEventListener(this) {
            @Override
            public void onOrientationChanged(int degrees) {
                if (degrees == ORIENTATION_UNKNOWN) return;
                int snapped = ((degrees + 45) / 90 * 90) % 360;
                if (snapped != deviceOrientation) {
                    deviceOrientation = snapped;
                    publishInfo();
                }
            }
        };

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        preview = new SurfaceView(this);
        FrameLayout.LayoutParams plp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT);
        plp.gravity = Gravity.CENTER;
        root.addView(preview, plp);

        // The picture is 16:9 and phone screens are longer than that. Letting
        // the preview fill the screen stretched it; fit it inside instead.
        root.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> fitPreview(r - l, b - t));

        status = new TextView(this);
        status.setTextColor(Color.WHITE);
        status.setTextSize(14);
        status.setPadding(36, 24, 36, 24);
        status.setBackgroundColor(0x99000000);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT);
        lp.gravity = Gravity.BOTTOM | Gravity.START;
        root.addView(status, lp);

        setContentView(root);

        preview.getHolder().setFixedSize(1280, 720);
        preview.getHolder().addCallback(new SurfaceHolder.Callback() {
            @Override
            public void surfaceCreated(SurfaceHolder holder) {
                previewReady = true;
                maybeStart();
            }

            @Override
            public void surfaceChanged(SurfaceHolder holder, int format, int w, int h) {
            }

            @Override
            public void surfaceDestroyed(SurfaceHolder holder) {
                previewReady = false;
                stopPipeline();
            }
        });
    }

    private void fitPreview(int availableW, int availableH) {
        if (availableW <= 0 || availableH <= 0) return;
        int w = availableW;
        int h = Math.round(w * 9f / 16f);
        if (h > availableH) {
            h = availableH;
            w = Math.round(h * 16f / 9f);
        }
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) preview.getLayoutParams();
        if (lp.width != w || lp.height != h) {
            lp.width = w;
            lp.height = h;
            lp.gravity = Gravity.CENTER;
            preview.setLayoutParams(lp);
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            setStatus("Camera permission needed");
            requestPermissions(new String[]{Manifest.permission.CAMERA}, 1);
            return;
        }
        maybeStart();
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED) maybeStart();
        else setStatus("Camera permission denied");
    }

    @Override
    protected void onPause() {
        stopPipeline();
        super.onPause();
    }

    // ------------------------------------------------------------------ orientation

    // The encoder receives frames exactly as the sensor produces them, which
    // is only upright for one way of holding the phone. Rather than rotate
    // pixels here (a copy per frame), the PC is told how far to turn the
    // picture, and whether it is a mirror image, and does it for free.

    private void readCameraFacts() {
        try {
            characteristics = getSystemService(CameraManager.class).getCameraCharacteristics(cameraId);
            Integer so = characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION);
            Integer facing = characteristics.get(CameraCharacteristics.LENS_FACING);
            sensorOrientation = so == null ? 90 : so;
            facingFront = facing != null && facing == CameraCharacteristics.LENS_FACING_FRONT;
        } catch (CameraAccessException | IllegalArgumentException e) {
            Log.w(TAG, "could not read camera facts: " + e);
        }
    }

    /** Clockwise degrees the PC must turn the picture for it to be upright. */
    private int pictureRotation() {
        int device = facingFront ? -deviceOrientation : deviceOrientation;
        return ((sensorOrientation + device) % 360 + 360) % 360;
    }

    /** Stream description, what this camera can do, and the controls in force. */
    private void publishInfo() {
        StreamServer s = server;
        if (s == null) return;
        try {
            JSONObject info = new JSONObject();
            info.put("width", WIDTH);
            info.put("height", HEIGHT);
            info.put("fps", FPS);
            info.put("codec", "avc");
            info.put("camera", cameraId);
            info.put("rotation", pictureRotation());
            info.put("front", facingFront);
            info.put("caps", capabilities());
            info.put("controls", controls);
            s.setInfo(info.toString());
        } catch (JSONException e) {
            Log.w(TAG, "info: " + e);
        }
    }

    private static JSONArray ints(int[] values) {
        JSONArray a = new JSONArray();
        if (values != null) for (int v : values) a.put(v);
        return a;
    }

    private JSONObject capabilities() throws JSONException {
        JSONObject caps = new JSONObject();
        CameraCharacteristics c = characteristics;
        if (c == null) return caps;

        Range<Integer> ae = c.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE);
        Rational step = c.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP);
        if (ae != null && step != null && ae.getUpper() > ae.getLower()) {
            caps.put("exposure", new JSONArray().put(ae.getLower()).put(ae.getUpper()));
            caps.put("exposureStep", step.doubleValue());
        }
        if (Build.VERSION.SDK_INT >= 30) {
            Range<Float> zoom = c.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE);
            if (zoom != null) {
                caps.put("zoom", new JSONArray().put((double) zoom.getLower()).put((double) zoom.getUpper()));
            }
        }
        Float minFocus = c.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE);
        if (minFocus != null && minFocus > 0) caps.put("minFocus", (double) minFocus);

        caps.put("wb", ints(c.get(CameraCharacteristics.CONTROL_AWB_AVAILABLE_MODES)));
        caps.put("antibanding", ints(c.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_ANTIBANDING_MODES)));
        caps.put("edge", ints(c.get(CameraCharacteristics.EDGE_AVAILABLE_EDGE_MODES)));
        caps.put("nr", ints(c.get(CameraCharacteristics.NOISE_REDUCTION_AVAILABLE_NOISE_REDUCTION_MODES)));

        // Offer the first camera facing each way: the logical rear camera
        // covers every rear lens through zoom.
        JSONArray cameras = new JSONArray();
        try {
            CameraManager manager = getSystemService(CameraManager.class);
            boolean haveBack = false;
            boolean haveFront = false;
            for (String id : manager.getCameraIdList()) {
                Integer facing = manager.getCameraCharacteristics(id).get(CameraCharacteristics.LENS_FACING);
                boolean front = facing != null && facing == CameraCharacteristics.LENS_FACING_FRONT;
                boolean back = facing != null && facing == CameraCharacteristics.LENS_FACING_BACK;
                if ((front && !haveFront) || (back && !haveBack)) {
                    cameras.put(new JSONObject().put("id", id).put("front", front));
                    if (front) haveFront = true;
                    else haveBack = true;
                }
            }
        } catch (CameraAccessException e) {
            Log.w(TAG, "camera list: " + e);
        }
        caps.put("cameras", cameras);
        return caps;
    }

    // ------------------------------------------------------------------ pipeline

    private void maybeStart() {
        if (running || !previewReady) return;
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return;
        running = true;
        framesSent = 0;

        cameraThread = new HandlerThread("obsoloom-camera");
        cameraThread.start();
        cameraHandler = new Handler(cameraThread.getLooper());
        encoderThread = new HandlerThread("obsoloom-encoder");
        encoderThread.start();
        encoderHandler = new Handler(encoderThread.getLooper());

        readCameraFacts();
        server = new StreamServer(SOCKET, this);
        publishInfo();
        server.start();
        orientationListener.enable();

        try {
            startEncoder();
            openCamera();
            setStatus("Waiting for Obsoloom on the PC…");
        } catch (Exception e) {
            Log.e(TAG, "start failed", e);
            setStatus("Could not start: " + e.getMessage());
            stopPipeline();
        }
    }

    private void startEncoder() throws Exception {
        MediaFormat format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, WIDTH, HEIGHT);
        format.setInteger(MediaFormat.KEY_COLOR_FORMAT,
                MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        format.setInteger(MediaFormat.KEY_BIT_RATE, BITRATE);
        format.setInteger(MediaFormat.KEY_FRAME_RATE, FPS);
        // A keyframe every second: a client that connects, or one that fell
        // behind, is never more than a second from being able to decode.
        format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
        // This is a live camera, not a file: favour delay over compression.
        format.setInteger(MediaFormat.KEY_LOW_LATENCY, 1);
        format.setInteger(MediaFormat.KEY_PRIORITY, 0);
        // No B-frames, so frames leave the encoder in the order they entered.
        format.setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0);
        // Say what the colours are, so the stream carries it and the PC does not
        // have to guess: a wrong guess at the range is a grey, faded picture.
        format.setInteger(MediaFormat.KEY_COLOR_STANDARD, MediaFormat.COLOR_STANDARD_BT709);
        format.setInteger(MediaFormat.KEY_COLOR_RANGE, MediaFormat.COLOR_RANGE_LIMITED);
        format.setInteger(MediaFormat.KEY_COLOR_TRANSFER, MediaFormat.COLOR_TRANSFER_SDR_VIDEO);

        encoder = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC);
        encoder.setCallback(new MediaCodec.Callback() {
            @Override
            public void onInputBufferAvailable(MediaCodec codec, int index) {
                // Input arrives through the surface, never through buffers.
            }

            @Override
            public void onOutputBufferAvailable(MediaCodec codec, int index, MediaCodec.BufferInfo info) {
                try {
                    ByteBuffer buffer = codec.getOutputBuffer(index);
                    if (buffer != null && info.size > 0 && server != null) {
                        byte[] data = new byte[info.size];
                        buffer.position(info.offset);
                        buffer.get(data, 0, info.size);
                        if ((info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) {
                            server.setConfig(data);
                        } else {
                            boolean key = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
                            server.sendFrame(data, info.presentationTimeUs, key);
                            if (server.hasClient() && (++framesSent % 30) == 0) updateStreamingStatus();
                        }
                    }
                    codec.releaseOutputBuffer(index, false);
                } catch (IllegalStateException e) {
                    // The codec was stopped underneath this callback.
                }
            }

            @Override
            public void onError(MediaCodec codec, MediaCodec.CodecException e) {
                Log.e(TAG, "encoder error", e);
                setStatus("Encoder error: " + e.getDiagnosticInfo());
            }

            @Override
            public void onOutputFormatChanged(MediaCodec codec, MediaFormat newFormat) {
                // Some encoders only publish SPS/PPS here rather than as a
                // config buffer. Both carry Annex-B start codes already.
                ByteBuffer sps = newFormat.getByteBuffer("csd-0");
                ByteBuffer pps = newFormat.getByteBuffer("csd-1");
                if (sps != null && pps != null && server != null) {
                    byte[] config = new byte[sps.remaining() + pps.remaining()];
                    int n = sps.remaining();
                    sps.get(config, 0, n);
                    pps.get(config, n, pps.remaining());
                    server.setConfig(config);
                }
            }
        }, encoderHandler);

        encoder.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        encoderSurface = encoder.createInputSurface();
        encoder.start();
    }

    @SuppressLint("MissingPermission")
    private void openCamera() throws CameraAccessException {
        CameraManager manager = getSystemService(CameraManager.class);
        manager.openCamera(cameraId, new CameraDevice.StateCallback() {
            @Override
            public void onOpened(CameraDevice device) {
                camera = device;
                startSession();
            }

            @Override
            public void onDisconnected(CameraDevice device) {
                device.close();
                if (camera == device) camera = null;
            }

            @Override
            public void onError(CameraDevice device, int error) {
                Log.e(TAG, "camera error " + error);
                setStatus("Camera error " + error);
                device.close();
                if (camera == device) camera = null;
            }
        }, cameraHandler);
    }

    private void startSession() {
        if (camera == null || encoderSurface == null) return;
        Surface previewSurface = preview.getHolder().getSurface();
        List<OutputConfiguration> outputs = Arrays.asList(
                new OutputConfiguration(previewSurface),
                new OutputConfiguration(encoderSurface));

        SessionConfiguration config = new SessionConfiguration(
                SessionConfiguration.SESSION_REGULAR,
                outputs,
                command -> cameraHandler.post(command),
                new CameraCaptureSession.StateCallback() {
                    @Override
                    public void onConfigured(CameraCaptureSession s) {
                        session = s;
                        startRepeating(previewSurface);
                    }

                    @Override
                    public void onConfigureFailed(CameraCaptureSession s) {
                        Log.e(TAG, "session configure failed");
                        setStatus("Camera session could not be configured");
                    }
                });
        try {
            camera.createCaptureSession(config);
        } catch (CameraAccessException e) {
            Log.e(TAG, "createCaptureSession", e);
            setStatus("Camera: " + e.getMessage());
        }
    }

    private void startRepeating(Surface previewSurface) {
        try {
            request = camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
            request.addTarget(previewSurface);
            request.addTarget(encoderSurface);
            // Stabilisation buffers frames, which is delay; the phone is on a stand.
            request.set(CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE,
                    CaptureRequest.CONTROL_VIDEO_STABILIZATION_MODE_OFF);

            // Hold a steady frame rate if the camera offers one; letting it
            // drop to 15fps in dim light makes motion look broken.
            Range<Integer>[] ranges = characteristics == null ? null
                    : characteristics.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
            if (ranges != null) {
                for (Range<Integer> r : ranges) {
                    if (r.getLower() == FPS && r.getUpper() == FPS) {
                        request.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, r);
                        break;
                    }
                }
            }
            applyControls();
            Log.i(TAG, "capturing " + WIDTH + "x" + HEIGHT + "@" + FPS + " camera " + cameraId);
        } catch (CameraAccessException | IllegalStateException e) {
            Log.e(TAG, "startRepeating", e);
            setStatus("Camera: " + e.getMessage());
        }
    }

    /** Swap cameras without dropping the PC: only the capture side restarts. */
    private void switchCamera(String id) {
        if (id.equals(cameraId) || cameraHandler == null) return;
        cameraHandler.post(() -> {
            try {
                if (session != null) session.close();
            } catch (Exception ignored) {
                // already closed
            }
            session = null;
            if (camera != null) camera.close();
            camera = null;

            cameraId = id;
            readCameraFacts();
            // Zoom and focus positions mean different things on another lens.
            controls.remove("zoom");
            controls.remove("focusDistance");
            publishInfo();
            try {
                openCamera();
            } catch (CameraAccessException | IllegalArgumentException e) {
                Log.e(TAG, "switchCamera", e);
                setStatus("Camera: " + e.getMessage());
            }
            onKeyframeWanted();
        });
    }

    private void stopPipeline() {
        if (!running) return;
        running = false;
        orientationListener.disable();
        try {
            if (session != null) session.close();
        } catch (Exception ignored) {
            // already closed
        }
        session = null;
        request = null;
        if (camera != null) camera.close();
        camera = null;
        if (server != null) server.stop();
        server = null;
        try {
            if (encoder != null) {
                encoder.stop();
                encoder.release();
            }
        } catch (Exception ignored) {
            // already stopped
        }
        encoder = null;
        if (encoderSurface != null) encoderSurface.release();
        encoderSurface = null;
        if (cameraThread != null) cameraThread.quitSafely();
        if (encoderThread != null) encoderThread.quitSafely();
        cameraHandler = null;
    }

    // ------------------------------------------------------------------ controls

    private static boolean has(int[] available, int wanted) {
        if (available == null) return false;
        for (int v : available) if (v == wanted) return true;
        return false;
    }

    /** Put everything in {@link #controls} onto the repeating request. */
    private void applyControls() {
        CaptureRequest.Builder r = request;
        CameraCaptureSession s = session;
        CameraCharacteristics c = characteristics;
        if (r == null || s == null || c == null) return;

        // Exposure
        r.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, controls.optInt("exposure", 0));
        r.set(CaptureRequest.CONTROL_AE_LOCK, controls.optBoolean("aeLock", false));
        int banding = controls.optInt("antibanding", CameraMetadata.CONTROL_AE_ANTIBANDING_MODE_AUTO);
        if (has(c.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_ANTIBANDING_MODES), banding)) {
            r.set(CaptureRequest.CONTROL_AE_ANTIBANDING_MODE, banding);
        }

        // White balance
        int wb = controls.optInt("wb", CameraMetadata.CONTROL_AWB_MODE_AUTO);
        if (has(c.get(CameraCharacteristics.CONTROL_AWB_AVAILABLE_MODES), wb)) {
            r.set(CaptureRequest.CONTROL_AWB_MODE, wb);
        }
        r.set(CaptureRequest.CONTROL_AWB_LOCK, controls.optBoolean("awbLock", false));

        // Focus: continuous autofocus, or a fixed distance in dioptres
        // (0 is infinity, larger is closer).
        if ("manual".equals(controls.optString("focusMode", "auto"))) {
            r.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_OFF);
            r.set(CaptureRequest.LENS_FOCUS_DISTANCE, (float) controls.optDouble("focusDistance", 1.0));
        } else {
            r.set(CaptureRequest.CONTROL_AF_MODE, CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO);
        }

        // Zoom. On the logical rear camera this also moves between the
        // ultrawide, main and telephoto lenses.
        if (Build.VERSION.SDK_INT >= 30 && controls.has("zoom")) {
            r.set(CaptureRequest.CONTROL_ZOOM_RATIO, (float) controls.optDouble("zoom", 1.0));
        }

        // The phone's own processing. Its default sharpening is tuned for
        // photos on a phone screen and can look harsh in a screen recording.
        if (controls.has("edge") && has(c.get(CameraCharacteristics.EDGE_AVAILABLE_EDGE_MODES), controls.optInt("edge"))) {
            r.set(CaptureRequest.EDGE_MODE, controls.optInt("edge"));
        }
        if (controls.has("nr") && has(c.get(CameraCharacteristics.NOISE_REDUCTION_AVAILABLE_NOISE_REDUCTION_MODES), controls.optInt("nr"))) {
            r.set(CaptureRequest.NOISE_REDUCTION_MODE, controls.optInt("nr"));
        }

        try {
            s.setRepeatingRequest(r.build(), null, cameraHandler);
        } catch (CameraAccessException | IllegalStateException | IllegalArgumentException e) {
            Log.w(TAG, "applyControls: " + e);
        }
    }

    // ------------------------------------------------------------------ server events

    @Override
    public void onClientChanged(boolean connected) {
        if (connected) updateStreamingStatus();
        else setStatus("Waiting for Obsoloom on the PC…");
    }

    @Override
    public void onKeyframeWanted() {
        MediaCodec codec = encoder;
        if (codec == null) return;
        try {
            Bundle params = new Bundle();
            params.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
            codec.setParameters(params);
        } catch (IllegalStateException ignored) {
            // the codec is stopping
        }
    }

    /**
     * {"set": {...}} merges control values; {"reset": true} returns the camera
     * to automatic. "camera" inside a set switches lens direction.
     */
    @Override
    public void onControl(String json) {
        Handler handler = cameraHandler;
        if (handler == null) return;
        handler.post(() -> {
            try {
                JSONObject message = new JSONObject(json);
                String switchTo = null;

                if (message.optBoolean("keyframe", false)) {
                    // The PC lost its place in the stream: give it a fresh start now
                    // rather than at the next scheduled keyframe.
                    onKeyframeWanted();
                    if (message.length() == 1) return;
                }
                if (message.optBoolean("reset", false)) {
                    controls = new JSONObject();
                }
                JSONObject set = message.optJSONObject("set");
                if (set != null) {
                    for (Iterator<String> it = set.keys(); it.hasNext(); ) {
                        String key = it.next();
                        if ("camera".equals(key)) switchTo = set.optString(key);
                        else controls.put(key, set.get(key));
                    }
                }

                if (switchTo != null && !switchTo.isEmpty() && !switchTo.equals(cameraId)) {
                    switchCamera(switchTo);
                } else {
                    applyControls();
                    publishInfo();
                }
            } catch (JSONException e) {
                Log.w(TAG, "bad control message: " + json);
            }
        });
    }

    private void updateStreamingStatus() {
        setStatus("Streaming " + WIDTH + "×" + HEIGHT + " @ " + FPS + "fps over USB");
    }

    private void setStatus(String text) {
        runOnUiThread(() -> status.setText(text));
    }
}
