import { useEffect, useRef, useState } from "react";
import { Html5Qrcode, Html5QrcodeSupportedFormats } from "html5-qrcode";
import { Camera, Scan } from "lucide-react";
import { cn } from "@/lib/utils";

const ELEMENT_ID = "qr-reader-canvas";

// ── Helpers ──────────────────────────────────────────────────────────────────

function playBeep() {
  try {
    const ctx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = "sine";
    osc.frequency.setValueAtTime(1400, ctx.currentTime);
    gain.gain.setValueAtTime(0.4, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.18);
  } catch { /* ignore */ }
}

function doVibrate() {
  if ("vibrate" in navigator) {
    try { navigator.vibrate(80); } catch { /* ignore */ }
  }
}

// ── Native BarcodeDetector scanner ───────────────────────────────────────────

interface NativeBarcodeScannerProps {
  onScan: (text: string) => void;
  onError: (msg: string) => void;
  onReady: () => void;
}

function NativeBarcodeScanner({ onScan, onError, onReady }: NativeBarcodeScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastResultRef = useRef<string | null>(null);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const detector = new (window as unknown as {
          BarcodeDetector: new (opts: { formats: string[] }) => {
            detect: (src: HTMLVideoElement) => Promise<{ rawValue: string }[]>;
          };
        }).BarcodeDetector({
          formats: ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "qr_code", "data_matrix"],
        });

        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: "environment",
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
        });

        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        streamRef.current = stream;

        const video = videoRef.current!;
        video.srcObject = stream;
        await video.play();

        onReady();

        intervalRef.current = setInterval(async () => {
          if (!video || video.readyState < 2) return;
          try {
            const results = await detector.detect(video);
            if (results.length > 0) {
              const raw = results[0].rawValue;
              if (raw && raw !== lastResultRef.current) {
                lastResultRef.current = raw;
                playBeep();
                doVibrate();
                onScanRef.current(raw);
                // Reset duplicate guard after 3s
                setTimeout(() => { lastResultRef.current = null; }, 3000);
              }
            }
          } catch { /* frame not ready yet */ }
        }, 200);
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : "Nie można uruchomić kamery";
          onError(msg);
        }
      }
    })();

    return () => {
      cancelled = true;
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (streamRef.current) streamRef.current.getTracks().forEach((t) => t.stop());
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <video
      ref={videoRef}
      className="w-full block"
      autoPlay
      muted
      playsInline
      style={{ background: "black" }}
    />
  );
}

// ── html5-qrcode fallback scanner ────────────────────────────────────────────

interface FallbackScannerProps {
  onScan: (text: string) => void;
  onError: (msg: string) => void;
  onReady: () => void;
}

function FallbackScanner({ onScan, onError, onReady }: FallbackScannerProps) {
  const html5QrRef = useRef<Html5Qrcode | null>(null);
  const startedRef = useRef(false);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    const scanner = new Html5Qrcode(ELEMENT_ID, {
      verbose: false,
      formatsToSupport: [
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.CODE_39,
      ],
    });
    html5QrRef.current = scanner;

    scanner
      .start(
        { facingMode: "environment" },
        {
          fps: 15,
          qrbox: { width: 300, height: 150 },
          experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        },
        (decodedText) => {
          playBeep();
          doVibrate();
          onScanRef.current(decodedText);
        },
        () => { /* silent scan errors */ }
      )
      .then(() => {
        startedRef.current = true;
        onReady();
      })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        onError(msg);
      });

    return () => {
      if (startedRef.current) {
        scanner.stop().catch(() => {});
      }
      html5QrRef.current = null;
      startedRef.current = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div id={ELEMENT_ID} className="w-full" />;
}

// ── Main BarcodeScanner component ────────────────────────────────────────────

interface BarcodeScannerProps {
  onScan: (text: string) => void;
  className?: string;
}

function hasNativeBarcodeDetector(): boolean {
  return "BarcodeDetector" in window;
}

export function BarcodeScanner({ onScan, className }: BarcodeScannerProps) {
  const [status, setStatus] = useState<"loading" | "scanning" | "error">("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [useNative] = useState(() => hasNativeBarcodeDetector());

  const handleReady = () => setStatus("scanning");
  const handleError = (msg: string) => {
    setErrorMsg(msg);
    setStatus("error");
  };

  return (
    <div className={cn(
      "relative w-full max-w-sm mx-auto rounded-2xl overflow-hidden bg-black border border-white/10 shadow-2xl",
      className
    )}>
      {/* Top bar */}
      <div className="flex items-center gap-2 px-3 py-2 bg-black/80 border-b border-white/10">
        <Scan className="w-4 h-4 text-primary flex-shrink-0" />
        <span className="text-xs font-semibold text-white/60 tracking-wide">
          {status === "loading" && "Uruchamianie…"}
          {status === "scanning" && (useNative ? "Skanuję… (natywny)" : "Skanuję…")}
          {status === "error" && "Błąd kamery"}
        </span>
      </div>

      {/* Video / scanner area */}
      <div className="relative bg-black" style={{ minHeight: 260 }}>
        {useNative ? (
          <NativeBarcodeScanner onScan={onScan} onError={handleError} onReady={handleReady} />
        ) : (
          <FallbackScanner onScan={onScan} onError={handleError} onReady={handleReady} />
        )}

        {/* Loading overlay */}
        {status === "loading" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black z-10">
            <Camera className="w-10 h-10 text-primary/40 animate-pulse mb-3" />
            <p className="text-sm text-white/40 font-medium">Uruchamianie aparatu…</p>
          </div>
        )}

        {/* Error overlay */}
        {status === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/90 z-10 p-6 text-center">
            <Camera className="w-9 h-9 text-red-400/60 mb-3" />
            <p className="text-sm text-red-300 font-medium leading-relaxed">
              {errorMsg || "Nie można uruchomić kamery"}
            </p>
            <p className="mt-2 text-xs text-white/30">Skorzystaj z pola ręcznego poniżej</p>
          </div>
        )}

        {/* Laser overlay — shown when scanning */}
        {status === "scanning" && (
          <div className="absolute inset-0 pointer-events-none z-10 flex items-center justify-center">
            <div className="relative" style={{ width: useNative ? 320 : 300, maxWidth: "90%", height: useNative ? 160 : 150 }}>
              <span className="absolute top-0 left-0 w-7 h-7 border-t-2 border-l-2 border-primary rounded-tl" />
              <span className="absolute top-0 right-0 w-7 h-7 border-t-2 border-r-2 border-primary rounded-tr" />
              <span className="absolute bottom-0 left-0 w-7 h-7 border-b-2 border-l-2 border-primary rounded-bl" />
              <span className="absolute bottom-0 right-0 w-7 h-7 border-b-2 border-r-2 border-primary rounded-br" />
              <div className="laser-line absolute left-3 right-3 h-px bg-gradient-to-r from-transparent via-red-500 to-transparent shadow-[0_0_8px_2px_rgba(239,68,68,0.5)]" />
            </div>
          </div>
        )}
      </div>

      {/* Bottom hint */}
      <div className="px-4 py-2 bg-black/80 border-t border-white/10 text-center">
        <p className="text-xs text-white/35 font-medium">
          {status === "scanning" && "Trzymaj telefon stabilnie, kod kreskowy w ramce"}
          {status === "loading" && "Proszę czekać…"}
          {status === "error" && "Sprawdź uprawnienia kamery w przeglądarce"}
        </p>
      </div>
    </div>
  );
}
