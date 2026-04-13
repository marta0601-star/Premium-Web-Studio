import React, { forwardRef, useState, useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, Loader2 } from "lucide-react";

export const PremiumButton = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement> & { isLoading?: boolean; variant?: 'primary' | 'secondary' }>(
  ({ className, children, isLoading, disabled, variant = 'primary', ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={isLoading || disabled}
        className={cn(
          "relative flex items-center justify-center gap-2 px-6 py-3.5 rounded-xl font-semibold transition-all duration-300 ease-out overflow-hidden group",
          "disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none",
          variant === 'primary' 
            ? "bg-gradient-to-r from-amber-500 to-orange-500 text-black shadow-[0_0_20px_rgba(245,158,11,0.2)] hover:shadow-[0_0_30px_rgba(245,158,11,0.4)] hover:-translate-y-0.5 active:translate-y-0"
            : "bg-white/5 border border-white/10 text-white hover:bg-white/10 hover:border-white/20 hover:-translate-y-0.5 active:translate-y-0",
          className
        )}
        {...props}
      >
        {variant === 'primary' && (
          <div className="absolute inset-0 bg-white/20 translate-y-full group-hover:translate-y-0 transition-transform duration-300 ease-in-out" />
        )}
        <span className="relative z-10 flex items-center gap-2">
          {isLoading && <Loader2 className="w-5 h-5 animate-spin" />}
          {children}
        </span>
      </button>
    );
  }
);
PremiumButton.displayName = "PremiumButton";

export const PremiumInput = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          "w-full px-4 py-3.5 rounded-xl bg-black/40 border border-white/10 text-white placeholder:text-white/30",
          "focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary focus:bg-black/60",
          "transition-all duration-200",
          className
        )}
        {...props}
      />
    );
  }
);
PremiumInput.displayName = "PremiumInput";

export const PremiumSelect = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => {
    return (
      <div className="relative w-full">
        <select
          ref={ref}
          className={cn(
            "w-full px-4 py-3.5 rounded-xl bg-black/40 border border-white/10 text-white appearance-none",
            "focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary focus:bg-black/60",
            "transition-all duration-200 cursor-pointer",
            className
          )}
          {...props}
        >
          {children}
        </select>
        <ChevronDown className="absolute right-4 top-1/2 -translate-y-1/2 w-5 h-5 text-white/50 pointer-events-none" />
      </div>
    );
  }
);
PremiumSelect.displayName = "PremiumSelect";

// Custom JS dropdown — works reliably on iOS/Android (avoids native <select> compositing bugs)
export const CustomSelect = ({
  value,
  onChange,
  options,
  placeholder = "Wybierz wartość...",
  required,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Array<{ value: string; label: string; disabled?: boolean }>;
  placeholder?: string;
  required?: boolean;
  className?: string;
}) => {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value && !o.disabled);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | TouchEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("touchstart", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("touchstart", close);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative w-full">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "w-full px-4 py-3.5 rounded-xl bg-black/40 border border-white/10 text-white text-left flex items-center justify-between gap-2",
          "focus:outline-none focus:border-primary focus:ring-1 focus:ring-primary focus:bg-black/60",
          "transition-all duration-200 cursor-pointer touch-manipulation select-none",
          !selected && "text-white/40",
          className
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
        required={required}
      >
        <span className="truncate text-sm">{selected ? selected.label : placeholder}</span>
        <ChevronDown className={cn("w-5 h-5 text-white/50 shrink-0 transition-transform duration-200", open && "rotate-180")} />
      </button>

      {open && (
        <div
          role="listbox"
          className="absolute top-full left-0 right-0 z-50 mt-1 bg-zinc-900 border border-white/20 rounded-xl shadow-2xl overflow-hidden"
        >
          <div className="max-h-60 overflow-y-auto overscroll-contain">
            {options.filter((o) => !o.disabled).map((opt) => (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={opt.value === value}
                onClick={() => { onChange(opt.value); setOpen(false); }}
                className={cn(
                  "w-full px-4 py-3 text-left text-sm border-b border-white/5 last:border-0",
                  "hover:bg-white/10 active:bg-white/20 transition-colors touch-manipulation",
                  opt.value === value
                    ? "text-primary font-semibold bg-primary/10"
                    : "text-white"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export const PremiumSwitch = ({ checked, onChange }: { checked: boolean; onChange: (c: boolean) => void }) => {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-7 w-12 items-center rounded-full transition-colors duration-300 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background",
        checked ? "bg-primary" : "bg-white/10 border border-white/10"
      )}
    >
      <span
        className={cn(
          "inline-block h-5 w-5 transform rounded-full bg-white transition-transform duration-300 shadow-sm",
          checked ? "translate-x-6" : "translate-x-1"
        )}
      />
    </button>
  );
};
