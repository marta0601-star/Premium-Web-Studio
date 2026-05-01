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
import { useCallback, useEffect, useRef, useState } from "react";
import { BrowserMultiFormatReader, type IScannerControls } from "@zxing/browser";
import { BarcodeFormat, DecodeHintType } from "@zxing/library";
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

// ── Component ────────────────────────────────────────────────────────────────

interface BarcodeScannerProps {
  onScan: (text: string) => void;
}

type EngineKind = "native" | "zxing";

export function BarcodeScanner({ onScan }: BarcodeScannerProps) {
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  const videoRef = useRef<HTMLVideoElement | null>(null);
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
      videoEl.srcObject = stream;
      try {
        await videoEl.play();
      } catch {
        /* iOS sometimes throws AbortError when play() is interrupted by
           a quick teardown — harmless, srcObject is still attached. */
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
      cleanupRef.current?.();
      cleanupRef.current = null;
    };
  }, [bootCount, handleDetected]);

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
        />
        {/* Visible scan-line overlay — `.laser-line` keyframes already live in
            src/index.css; the absolute/colour utilities here just give the
            element height, position and a primary-tinted hairline so the
            existing animation has something to paint. */}
        <div
          className="laser-line absolute left-0 right-0 h-0.5 bg-primary shadow-[0_0_8px_rgba(255,255,255,0.6)] pointer-events-none z-10"
          aria-hidden
        />
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
