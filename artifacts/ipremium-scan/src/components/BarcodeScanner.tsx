/**
 * Hybrid EAN scanner — native BarcodeDetector first, ZXing fallback.
 *
 *   • Chrome/Edge (desktop + Android), Samsung Internet → native
 *     BarcodeDetector. On Android Chrome the underlying engine is Google
 *     ML Kit, which is *materially* faster and more accurate than any
 *     JS-side decoder we can ship. It scans the whole video frame.
 *
 *   • iOS Safari, Firefox, anything else → a self-driven decode loop that
 *     crops a NATIVE-resolution ROI band from the camera frame and decodes
 *     just that band. The decoder is zxing-wasm (the C++ ZXing compiled to
 *     WebAssembly — markedly faster/more accurate on iOS than the old pure-JS
 *     @zxing/library), with @zxing/library kept as an automatic fallback if
 *     the wasm module ever fails to instantiate. Cropping the band at native
 *     resolution (instead of decoding the CSS-downscaled <video> paint)
 *     preserves the horizontal module density that 1-D EAN/UPC decoding lives
 *     or dies on — this is the single biggest accuracy lever on iPhone.
 *
 * The component preserves the UX from earlier versions: laser-line overlay
 * (CSS in src/index.css), ROI aim box, 100 ms vibration + short beep on
 * success, "skúste priblížiť…" hint after 5 s of nothing, classified
 * camera-error screen with a retry button, torch + tap-to-focus.
 *
 * Stable-read guard: the same (normalised) code must arrive twice in a row
 * before we commit, which kills the rare false-positive on a half-occluded
 * code. UPC-A/UPC-E are normalised to EAN-13 before the guard so the streak
 * comparison is symbology-agnostic (see @/lib/ean normalizeBarcode).
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { BrowserMultiFormatReader } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { readBarcodes, prepareZXingModule, type ReaderOptions } from "zxing-wasm/reader";
import zxingWasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";
import { Flashlight } from "lucide-react";
import { normalizeBarcode } from "@/lib/ean";

// ── zxing-wasm bootstrap ─────────────────────────────────────────────────────
// Prewarm the WASM module ONCE at module load, served from our OWN origin via a
// Vite-fingerprinted asset (the package's default locateFile points at the
// jsDelivr CDN — we must override it, or scanning would silently depend on an
// external CDN at runtime). fireImmediately:true kicks off the fetch+compile now
// so the first frame on iOS isn't blocked on a cold ~1 MB wasm compile. The
// promise resolves to `true` when ready, `false` if instantiation failed (then
// we transparently fall back to the pure-JS @zxing/library decoder).
const zxingWasmReady: Promise<boolean> = prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith(".wasm") ? zxingWasmUrl : prefix + path,
  },
  fireImmediately: true,
})
  .then(() => true)
  .catch((err: unknown) => {
    console.warn("[BarcodeScanner] zxing-wasm init failed — using @zxing/library fallback", err);
    return false;
  });

const WASM_READER_OPTIONS: ReaderOptions = {
  formats: ["EAN-13", "EAN-8", "UPC-A", "UPC-E"],
  tryHarder: true, // optimise for accuracy — we run a self-paced loop, not every paint
  tryRotate: false, // the ROI band is horizontal & upright → save CPU per frame
  tryInvert: true, // decode white-on-dark codes (energy drinks / cosmetics)
  maxNumberOfSymbols: 1, // one barcode per frame is all we ever want
};

// ── Camera-error classification ──────────────────────────────────────────────

type CameraError = "permission" | "no_camera" | "in_use" | "other";

// getUserMedia error names → human-readable error category. The standard
// MediaError names are stable across browsers; anything else falls into
// "other" so we still show a useful message.
function classifyCameraError(err: unknown): CameraError {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "PermissionDeniedError") return "permission";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "no_camera";
  if (name === "NotReadableError" || name === "TrackStartError") return "in_use";
  return "other";
}

const CAMERA_ERROR_MESSAGES: Record<CameraError, string> = {
  permission: "Povoľte prístup ku kamere v nastaveniach prehliadača a skúste znova.",
  no_camera: "Toto zariadenie nemá dostupnú kameru. Použite manuálny vstup nižšie.",
  in_use: "Kamera je práve používaná inou aplikáciou. Zatvorte ju a skúste znova.",
  other: "Kameru sa nepodarilo spustiť. Skúste obnoviť stránku alebo použite manuálny vstup nižšie.",
};

// ── Native BarcodeDetector typings ───────────────────────────────────────────
// The W3C Shape Detection API isn't in lib.dom.d.ts yet (k 2026-05), so we
// declare just the surface we use. Format identifiers follow the spec —
// lowercase with underscores.

interface NativeDetectedBarcode {
  rawValue: string;
  format: string;
}

interface NativeBarcodeDetector {
  detect(source: HTMLVideoElement): Promise<NativeDetectedBarcode[]>;
}

interface NativeBarcodeDetectorCtor {
  new (init: { formats: string[] }): NativeBarcodeDetector;
  getSupportedFormats(): Promise<string[]>;
}

const NATIVE_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e"];

const ZXING_JS_FORMATS: BarcodeFormat[] = [
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
];

// Map a @zxing/library BarcodeFormat enum to the symbology hint normalizeBarcode
// understands, so an 8-digit UPC-E from the JS fallback is expanded rather than
// mistaken for an EAN-8 (the two are checksum-ambiguous).
function zxingFormatHint(format: BarcodeFormat): string | undefined {
  switch (format) {
    case BarcodeFormat.UPC_E:
      return "upc_e";
    case BarcodeFormat.EAN_8:
      return "ean_8";
    case BarcodeFormat.UPC_A:
      return "upc_a";
    case BarcodeFormat.EAN_13:
      return "ean_13";
    default:
      return undefined;
  }
}

// Ask for a high-res back-camera stream. iOS hands back the nearest supported
// mode (often 1280×720 or 1920×1080) — we read videoWidth/videoHeight at runtime
// for the crop, never trusting the requested numbers. focusMode lives only in an
// `advanced` set (best-effort): Android Chrome honours continuous AF; iOS Safari
// ignores the unsupported key harmlessly and gives OS autofocus via `environment`.
const VIDEO_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: { ideal: "environment" },
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30, max: 30 },
    advanced: [{ focusMode: "continuous" } as FocusConstraintSet],
  },
};

// Centred native-resolution ROI band. Full-ish width (1-D codes have horizontal
// quiet zones) × half height — generous vs the visible 40 % overlay so a slightly
// mis-aimed code still lands inside, while cutting ~half the pixels so TRY_HARDER
// stays cheap and the effective bar density rises. With object-fit:cover the box
// centre always maps to the frame centre, so a centred band is robust without any
// fragile CSS→pixel inverse-cover mapping.
const ROI_WIDTH_FRAC = 0.92;
const ROI_HEIGHT_FRAC = 0.5;

// Self-paced decode cadence for the fallback loop (~8 fps). The loop is
// sequential (await decode → schedule next), so this also bounds CPU on mobile.
const DECODE_INTERVAL_MS = 120;

// `torch` and `focusMode` are vendor extensions to MediaTrackCapabilities /
// MediaTrackConstraintSet that lib.dom.d.ts doesn't yet declare (k 2026-05).
// We narrow with these augmenting types where we read or apply them.
type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean };
type FocusCapabilities = MediaTrackCapabilities & { focusMode?: string[] };
type ResolutionCapabilities = MediaTrackCapabilities & {
  width?: { max?: number };
  height?: { max?: number };
};
type TorchConstraintSet = MediaTrackConstraintSet & { torch?: boolean };
type FocusConstraintSet = MediaTrackConstraintSet & { focusMode?: string };

function isIOS(): boolean {
  return (
    /iP(hone|ad|od)/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

// Best-effort track tuning, run once after the stream is live. Continuous
// autofocus (Android honours it; iOS ignores it harmlessly) plus, on non-iOS
// only, a capped bump toward the sensor's max resolution. Everything is wrapped
// so a failed apply never tears down the stream.
async function tuneTrackForScanning(track: MediaStreamTrack | undefined): Promise<void> {
  if (!track || track.readyState !== "live" || typeof track.getCapabilities !== "function") return;
  try {
    const caps = track.getCapabilities() as FocusCapabilities & ResolutionCapabilities;
    const constraints: MediaTrackConstraints = {};
    if (caps.focusMode?.includes("continuous")) {
      constraints.advanced = [{ focusMode: "continuous" } as FocusConstraintSet];
    }
    // iOS throttles the decoder on very high-res streams; the native-res ROI
    // crop already captures the resolution benefit, so only push resolution on
    // non-iOS devices, and cap it so we never feed a 4K frame to the loop.
    if (!isIOS() && caps.width?.max && caps.height?.max) {
      constraints.width = { ideal: Math.min(caps.width.max, 1920) };
      constraints.height = { ideal: Math.min(caps.height.max, 1080) };
    }
    if (constraints.advanced || constraints.width) {
      await track.applyConstraints(constraints);
    }
  } catch (err) {
    console.warn("[scanner] track tuning failed", err);
  }
}

// Draw the centred native-resolution ROI band of `video` into the reused
// `canvas`/`ctx` and return its ImageData (consumed by zxing-wasm readBarcodes;
// the canvas itself is consumed by the @zxing/library fallback). Returns null —
// caller skips the frame and retries next tick — when the frame isn't decodable
// yet (no metadata / no painted frame / degenerate ROI).
function drawRoiBand(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
): ImageData | null {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  // videoWidth/Height are 0 until loadedmetadata; readyState < 2 means no current
  // frame is painted yet — decoding either yields garbage or throws.
  if (vw === 0 || vh === 0 || video.readyState < 2) return null;

  const sw = Math.max(1, Math.round(vw * ROI_WIDTH_FRAC));
  const sh = Math.max(1, Math.round(vh * ROI_HEIGHT_FRAC));
  const sx = Math.round((vw - sw) / 2);
  const sy = Math.round((vh - sh) / 2);

  // Only reallocate the backing store when the ROI size actually changes.
  if (canvas.width !== sw) canvas.width = sw;
  if (canvas.height !== sh) canvas.height = sh;

  // 1:1 native blit — source rect copied to a same-sized canvas, no downscale,
  // so the horizontal module density is preserved.
  ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
  try {
    return ctx.getImageData(0, 0, sw, sh);
  } catch {
    return null; // cross-origin taint can't happen on a gUM stream; fail soft
  }
}

// Short success beep (in addition to the haptic). Best-effort: a suspended /
// blocked AudioContext on iOS simply no-ops, vibration still fires.
let sharedAudioCtx: AudioContext | null = null;
function playSuccessFeedback(): void {
  if (typeof navigator.vibrate === "function") navigator.vibrate(100);
  try {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    if (!sharedAudioCtx) sharedAudioCtx = new Ctor();
    const ctx = sharedAudioCtx;
    if (ctx.state === "suspended") void ctx.resume().catch(() => {});
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = 880;
    osc.connect(gain);
    gain.connect(ctx.destination);
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0.08, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
    osc.start(t);
    osc.stop(t + 0.16);
  } catch {
    /* best-effort — audio is a nice-to-have on top of vibration */
  }
}

// ── Component ────────────────────────────────────────────────────────────────

interface BarcodeScannerProps {
  onScan: (text: string) => void;
}

type EngineKind = "native" | "zxing-wasm" | "zxing-js";

const ENGINE_LABEL: Record<EngineKind, string> = {
  native: "native BarcodeDetector",
  "zxing-wasm": "ZXing-WASM",
  "zxing-js": "ZXing JS",
};

export function BarcodeScanner({ onScan }: BarcodeScannerProps) {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stoppedRef = useRef(false);
  const lastDetectRef = useRef(Date.now());
  const cleanupRef = useRef<(() => void) | null>(null);
  const lastCodeRef = useRef("");
  const readCountRef = useRef(0);

  const [showHint, setShowHint] = useState(false);
  const [cameraError, setCameraError] = useState<CameraError | null>(null);
  // Bumped by retryCamera to force the boot useEffect to re-run after the
  // user dismisses an error and the <video> element re-mounts.
  const [bootCount, setBootCount] = useState(0);
  const [engine, setEngine] = useState<EngineKind | null>(null);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);
  const [focusPulse, setFocusPulse] = useState<{ x: number; y: number; key: number } | null>(null);

  // Probe the active video track for the `torch` capability. Run after the
  // stream is playing on either engine path. iOS Safari only reports torch
  // from 17.4+; on older versions the getCapabilities() result has no `torch`
  // key and we (correctly) hide the button.
  const detectTorchSupport = useCallback(() => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || typeof track.getCapabilities !== "function") {
      setTorchSupported(false);
      return;
    }
    try {
      const caps = track.getCapabilities() as TorchCapabilities;
      setTorchSupported("torch" in caps && caps.torch !== undefined);
    } catch {
      setTorchSupported(false);
    }
  }, []);

  // Single sink for every detection (native + fallback). Normalise (UPC-A/UPC-E
  // → EAN-13, checksum-gated) then require the same code 2× in a row → commit,
  // feedback, tear down. Anything else just resets the streak.
  const handleDetected = useCallback((rawCode: string, formatHint?: string) => {
    if (stoppedRef.current) return;
    const code = normalizeBarcode(rawCode, formatHint);
    if (!code) return;

    lastDetectRef.current = Date.now();
    setShowHint(false);

    if (code === lastCodeRef.current) {
      readCountRef.current++;
      if (readCountRef.current >= 2) {
        stoppedRef.current = true;
        playSuccessFeedback();
        cleanupRef.current?.();
        cleanupRef.current = null;
        onScanRef.current(code);
      }
    } else {
      lastCodeRef.current = code;
      readCountRef.current = 1;
    }
  }, []);

  useEffect(() => {
    let aborted = false;
    stoppedRef.current = false;
    lastCodeRef.current = "";
    readCountRef.current = 0;
    lastDetectRef.current = Date.now();
    setTorchSupported(false);
    setTorchOn(false);
    setFocusPulse(null);

    // ── Native BarcodeDetector path ────────────────────────────────────────
    async function bootNative(Ctor: NativeBarcodeDetectorCtor) {
      const stream = await navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS);
      if (aborted) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const videoEl = videoRef.current;
      if (!videoEl) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      videoEl.srcObject = stream;
      try {
        await videoEl.play();
      } catch {
        /* iOS sometimes throws AbortError when play() is interrupted by
           a quick teardown — harmless, srcObject is still attached. */
      }
      // cleanupRef isn't assigned until the tick loop is wired below, so if the
      // effect tore down during play()/tuning we must stop the stream we opened
      // ourselves — otherwise the camera LED latches on and the next mount hits
      // NotReadableError. (The fallback path guards the same way.)
      if (aborted) {
        videoEl.srcObject = null;
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      detectTorchSupport();
      await tuneTrackForScanning(stream.getVideoTracks()[0]);
      if (aborted) {
        videoEl.srcObject = null;
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const detector = new Ctor({ formats: NATIVE_FORMATS });

      // Prefer requestVideoFrameCallback when present (Chromium) — it fires
      // exactly once per painted frame, so we never decode the same image
      // twice. Fall back to rAF on older Chromium / Edge.
      const useRVFC = "requestVideoFrameCallback" in HTMLVideoElement.prototype;
      let rafId: number | null = null;
      let inFlight = false;

      const tick = () => {
        if (aborted || stoppedRef.current) return;
        if (!inFlight && videoEl.readyState >= 2) {
          inFlight = true;
          detector
            .detect(videoEl)
            .then((codes) => {
              for (const c of codes) {
                if (c.rawValue) handleDetected(c.rawValue, c.format);
                if (stoppedRef.current) break;
              }
            })
            .catch(() => {
              /* per-frame decode errors are routine — ignore */
            })
            .finally(() => {
              inFlight = false;
            });
        }
        if (useRVFC) {
          rafId = (
            videoEl as HTMLVideoElement & {
              requestVideoFrameCallback: (cb: () => void) => number;
            }
          ).requestVideoFrameCallback(tick);
        } else {
          rafId = requestAnimationFrame(tick);
        }
      };
      tick();

      cleanupRef.current = () => {
        if (rafId !== null) {
          if (useRVFC) {
            const cancel = (
              videoEl as HTMLVideoElement & {
                cancelVideoFrameCallback?: (id: number) => void;
              }
            ).cancelVideoFrameCallback;
            cancel?.call(videoEl, rafId);
          } else {
            cancelAnimationFrame(rafId);
          }
          rafId = null;
        }
        videoEl.srcObject = null;
        stream.getTracks().forEach((t) => t.stop());
      };
    }

    // ── Self-driven fallback path (iOS Safari / Firefox / etc.) ─────────────
    // We open ONE getUserMedia, own the stream, crop a native-res ROI band each
    // tick and decode it with zxing-wasm (or @zxing/library if wasm failed).
    async function bootFallback() {
      const stream = await navigator.mediaDevices.getUserMedia(VIDEO_CONSTRAINTS);
      if (aborted) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const videoEl = videoRef.current;
      if (!videoEl) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      // Own the stream immediately so torch/focus/teardown all see the track,
      // even during the async decoder warmup below.
      streamRef.current = stream;
      videoEl.srcObject = stream;
      try {
        await videoEl.play();
      } catch {
        /* harmless AbortError on quick teardown — srcObject stays attached */
      }
      if (aborted) {
        videoEl.srcObject = null;
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      detectTorchSupport();
      await tuneTrackForScanning(stream.getVideoTracks()[0]);

      // Decide decoder: zxing-wasm if the module instantiated, else @zxing/library.
      const useWasm = await zxingWasmReady;
      if (aborted) {
        videoEl.srcObject = null;
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      setEngine(useWasm ? "zxing-wasm" : "zxing-js");

      // One reused canvas for the whole session (per-frame allocation would
      // thrash GC). willReadFrequently keeps the buffer CPU-side for getImageData.
      const canvas = document.createElement("canvas");
      const ctx = canvas.getContext("2d", { willReadFrequently: true });

      let jsReader: BrowserMultiFormatReader | null = null;
      if (!useWasm) {
        const hints = new Map<DecodeHintType, unknown>();
        hints.set(DecodeHintType.POSSIBLE_FORMATS, ZXING_JS_FORMATS);
        hints.set(DecodeHintType.TRY_HARDER, true);
        jsReader = new BrowserMultiFormatReader(hints);
      }

      let timer: number | null = null;

      // Sequential loop: decode, then schedule the next tick — never overlapping
      // (implicit in-flight guard), self-cancelling on abort/stop after every await.
      const loop = async () => {
        if (aborted || stoppedRef.current) return;
        const img = ctx ? drawRoiBand(videoEl, canvas, ctx) : null;
        if (img) {
          try {
            if (useWasm) {
              const results = await readBarcodes(img, WASM_READER_OPTIONS);
              if (aborted || stoppedRef.current) return;
              for (const r of results) {
                if (r.text) handleDetected(r.text, r.format);
                if (stoppedRef.current) break;
              }
            } else if (jsReader) {
              // decodeFromCanvas is single-shot and THROWS NotFoundException
              // when nothing is found — that's the common case, swallow it.
              try {
                const result = jsReader.decodeFromCanvas(canvas);
                if (result) handleDetected(result.getText(), zxingFormatHint(result.getBarcodeFormat()));
              } catch {
                /* no code in this frame */
              }
            }
          } catch {
            /* unexpected decode error — drop this frame, keep scanning */
          }
        }
        if (aborted || stoppedRef.current) return;
        timer = window.setTimeout(loop, DECODE_INTERVAL_MS);
      };
      void loop();

      cleanupRef.current = () => {
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        videoEl.srcObject = null;
        stream.getTracks().forEach((t) => t.stop());
      };
    }

    // ── Engine selection ───────────────────────────────────────────────────
    async function boot() {
      try {
        const Ctor = (
          window as unknown as { BarcodeDetector?: NativeBarcodeDetectorCtor }
        ).BarcodeDetector;

        if (Ctor && typeof Ctor.getSupportedFormats === "function") {
          const supported = await Ctor.getSupportedFormats();
          if (aborted) return;
          if (supported.includes("ean_13") && supported.includes("ean_8")) {
            console.info("[BarcodeScanner] engine: native BarcodeDetector");
            setEngine("native");
            await bootNative(Ctor);
            return;
          }
          console.info(
            "[BarcodeScanner] BarcodeDetector present but missing EAN — falling back to ZXing",
          );
        } else {
          console.info("[BarcodeScanner] no BarcodeDetector — using ZXing");
        }
        await bootFallback();
      } catch (err) {
        if (!aborted) setCameraError(classifyCameraError(err));
      }
    }

    boot();

    // 5 s without any detection → encourage the user to adjust distance.
    const hintInterval = setInterval(() => {
      if (stoppedRef.current) return;
      if (Date.now() - lastDetectRef.current >= 5000) {
        setShowHint(true);
      }
    }, 1000);

    return () => {
      aborted = true;
      stoppedRef.current = true;
      clearInterval(hintInterval);
      // Best-effort torch-off before tearing down the track. The track.stop()
      // inside cleanupRef also kills the LED on every browser we've tested, but
      // applying torch:false first is tidier on engines that latch the LED state.
      const track = streamRef.current?.getVideoTracks()[0];
      if (track) {
        track
          .applyConstraints({ advanced: [{ torch: false } as TorchConstraintSet] })
          .catch(() => {});
      }
      cleanupRef.current?.();
      cleanupRef.current = null;
      streamRef.current = null;
    };
  }, [bootCount, handleDetected, detectTorchSupport]);

  const toggleTorch = useCallback(async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const next = !torchOn;
    try {
      await track.applyConstraints({ advanced: [{ torch: next } as TorchConstraintSet] });
      setTorchOn(next);
    } catch (err) {
      console.warn("[scanner] torch failed", err);
    }
  }, [torchOn]);

  // Tap-to-focus: bounce focus between manual and continuous to force the
  // camera to re-acquire focus on the tapped point. The 100 ms gap is enough
  // for the driver to register the "manual" state before we hand control back.
  const handleVideoTap = useCallback(async (e: ReactPointerEvent<HTMLVideoElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setFocusPulse({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      key: Date.now(),
    });
    window.setTimeout(() => setFocusPulse(null), 700);

    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || typeof track.getCapabilities !== "function") return;
    try {
      const caps = track.getCapabilities() as FocusCapabilities;
      if (
        caps.focusMode?.includes("manual") &&
        caps.focusMode?.includes("continuous")
      ) {
        await track.applyConstraints({
          advanced: [{ focusMode: "manual" } as FocusConstraintSet],
        });
        window.setTimeout(() => {
          track
            .applyConstraints({
              advanced: [{ focusMode: "continuous" } as FocusConstraintSet],
            })
            .catch(() => {});
        }, 100);
      }
    } catch {
      /* silent — focusMode not supported on this engine */
    }
  }, []);

  const retryCamera = useCallback(() => {
    setCameraError(null);
    setBootCount((n) => n + 1);
  }, []);

  if (cameraError) {
    return (
      <div className="w-full p-6 rounded-xl bg-red-500/10 border border-red-500/20 text-center space-y-4">
        <p className="text-sm text-red-400 font-medium">
          {CAMERA_ERROR_MESSAGES[cameraError]}
        </p>
        {cameraError !== "no_camera" && (
          <button
            type="button"
            onClick={retryCamera}
            className="inline-flex items-center px-4 py-2 rounded-lg bg-white/5 border border-white/10 text-white/80 text-sm font-medium hover:bg-white/10 hover:text-white transition-colors"
          >
            Skúsiť znova
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="w-full">
      <div id="reader">
        <video
          ref={videoRef}
          playsInline
          muted
          autoPlay
          onPointerDown={handleVideoTap}
        />

        {/* ROI frame — 80% × 40% capped at 320 × 160 px, centred. The
            box-shadow with a 9999 px spread paints a translucent black
            spotlight everywhere outside the ROI, clipped by the parent's
            `overflow: hidden`. The decoder crops a centred native-resolution
            band (see ROI_*_FRAC); this overlay is the matching UX aim cue. */}
        <div
          className="absolute pointer-events-none"
          style={{
            left: "50%",
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: "min(80%, 320px)",
            height: "min(40%, 160px)",
            boxShadow: "0 0 0 9999px rgba(0,0,0,0.3)",
          }}
          aria-hidden
        >
          <div className="absolute top-0 left-0 w-6 h-6 border-t-2 border-l-2 border-primary" />
          <div className="absolute top-0 right-0 w-6 h-6 border-t-2 border-r-2 border-primary" />
          <div className="absolute bottom-0 left-0 w-6 h-6 border-b-2 border-l-2 border-primary" />
          <div className="absolute bottom-0 right-0 w-6 h-6 border-b-2 border-r-2 border-primary" />
        </div>

        {/* Laser sweep across the full video (unchanged). Painted after the
            ROI overlay so it stays visible over the dimmed border area. */}
        <div
          className="laser-line absolute left-0 right-0 h-0.5 bg-primary shadow-[0_0_8px_rgba(255,255,255,0.6)] pointer-events-none z-10"
          aria-hidden
        />

        {focusPulse && (
          <div
            key={focusPulse.key}
            className="absolute pointer-events-none w-12 h-12 rounded-full border-2 border-primary z-20"
            style={{
              left: focusPulse.x - 24,
              top: focusPulse.y - 24,
              animation: "focus-pulse 700ms ease-out forwards",
            }}
            aria-hidden
          />
        )}

        {torchSupported && (
          <button
            type="button"
            onClick={toggleTorch}
            aria-label={torchOn ? "Vypnúť baterku" : "Zapnúť baterku"}
            aria-pressed={torchOn}
            className={`absolute top-2 right-2 z-30 w-10 h-10 rounded-full backdrop-blur flex items-center justify-center transition-colors ${
              torchOn
                ? "bg-primary/20 border border-primary text-primary"
                : "bg-black/40 border border-white/20 text-white/70 hover:text-white"
            }`}
          >
            <Flashlight className="w-5 h-5" />
          </button>
        )}
      </div>
      {showHint && (
        <p className="mt-2 text-center text-sm text-amber-400/80 font-medium">
          Skúste priblížiť alebo oddialiť telefón
        </p>
      )}
      {engine && (
        <p className="mt-1 text-center text-[10px] text-white/30 font-mono uppercase tracking-wider">
          Engine: {ENGINE_LABEL[engine]}
        </p>
      )}
    </div>
  );
}
