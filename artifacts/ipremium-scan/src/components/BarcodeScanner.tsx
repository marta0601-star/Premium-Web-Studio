/**
 * Hybrid EAN scanner — native BarcodeDetector first, ZXing fallback.
 *
 *   • Chrome/Edge (desktop + Android), Samsung Internet → native
 *     BarcodeDetector. On Android Chrome the underlying engine is Google
 *     ML Kit, which is *materially* faster and more accurate than any
 *     JS-side decoder we can ship.
 *
 *   • iOS Safari, Firefox, anything else → @zxing/browser
 *     (BrowserMultiFormatReader). Same WASM-free pure-JS decoder used
 *     by html5-qrcode under the hood, but here we drive it directly so
 *     we can constrain to EAN/UPC and pass our own MediaStreamConstraints.
 *
 * The component preserves the UX from the previous Quagga-based version:
 * laser-line overlay (CSS already in src/index.css), 100 ms vibration on
 * success, "skúste priblížiť…" hint after 5 s of nothing, classified
 * camera-error screen with a retry button.
 *
 * Stable-read guard: the same EAN must arrive twice in a row before we
 * commit, which on the native path corresponds to ~33 ms between detects
 * and on ZXing to ~100-200 ms — still imperceptible to the user but kills
 * the rare false-positive on a half-occluded code.
 */
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
import { Flashlight } from "lucide-react";
import { isValidEAN } from "@/lib/ean";

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

const ZXING_FORMATS: BarcodeFormat[] = [
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
];

const VIDEO_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    facingMode: "environment",
    width: { ideal: 1280 },
    height: { ideal: 720 },
  },
};

// `torch` and `focusMode` are vendor extensions to MediaTrackCapabilities /
// MediaTrackConstraintSet that lib.dom.d.ts doesn't yet declare (k 2026-05).
// We narrow with these augmenting types where we read or apply them.
type TorchCapabilities = MediaTrackCapabilities & { torch?: boolean };
type FocusCapabilities = MediaTrackCapabilities & { focusMode?: string[] };
type TorchConstraintSet = MediaTrackConstraintSet & { torch?: boolean };
type FocusConstraintSet = MediaTrackConstraintSet & { focusMode?: string };

// ── Component ────────────────────────────────────────────────────────────────

interface BarcodeScannerProps {
  onScan: (text: string) => void;
}

type EngineKind = "native" | "zxing";

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
    if (!track) {
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

  // Single sink for both native + zxing detections. Same code 2× in a row →
  // commit, vibrate, tear down. Anything else just resets the streak.
  const handleDetected = useCallback((rawCode: string) => {
    if (stoppedRef.current) return;
    const code = rawCode.trim();
    if (!isValidEAN(code)) return;

    lastDetectRef.current = Date.now();
    setShowHint(false);

    if (code === lastCodeRef.current) {
      readCountRef.current++;
      if (readCountRef.current >= 2) {
        stoppedRef.current = true;
        if (typeof navigator.vibrate === "function") navigator.vibrate(100);
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

      detectTorchSupport();

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
                if (c.rawValue) handleDetected(c.rawValue);
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

    // ── ZXing fallback path ────────────────────────────────────────────────
    async function bootZxing() {
      const hints = new Map<DecodeHintType, unknown>();
      hints.set(DecodeHintType.POSSIBLE_FORMATS, ZXING_FORMATS);
      // NOTE: tried to add DecodeHintType.ALSO_INVERTED (white-on-dark
      // barcodes — energy drinks, some cosmetics) but @zxing/library@0.22.0
      // doesn't expose that hint — the enum stops at ALLOWED_EAN_EXTENSIONS
      // (index 11). Re-evaluate when we bump the dep.
      const reader = new BrowserMultiFormatReader(hints);
      const videoEl = videoRef.current;
      if (!videoEl) return;

      let controls: IScannerControls | null = null;
      controls = await reader.decodeFromConstraints(
        VIDEO_CONSTRAINTS,
        videoEl,
        (result) => {
          if (aborted || stoppedRef.current) return;
          if (result) handleDetected(result.getText());
        },
      );

      if (aborted) {
        try { controls.stop(); } catch { /* ignore */ }
        return;
      }

      // ZXing attaches the MediaStream to videoEl.srcObject internally —
      // grab it so we can drive torch / focus on the same track.
      const zxStream = videoEl.srcObject as MediaStream | null;
      if (zxStream) {
        streamRef.current = zxStream;
        detectTorchSupport();
      }

      cleanupRef.current = () => {
        try { controls?.stop(); } catch { /* ignore */ }
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
        setEngine("zxing");
        await bootZxing();
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
      // below also kills the LED on every browser we've tested, but applying
      // torch:false first is tidier on engines that latch the LED state.
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
    if (!track) return;
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
            `overflow: hidden`. ZXing/BarcodeDetector still scan the whole
            frame; this is purely a UX cue for aim. */}
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
          Engine: {engine === "native" ? "native BarcodeDetector" : "ZXing fallback"}
        </p>
      )}
    </div>
  );
}
