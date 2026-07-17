import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/index.tsx";
import "./intro-loader.css";

export interface IntroLoaderProps {
  onDone?: () => void;
}

type StepId = "tap" | "type" | "assert";

const STEP_IDS: StepId[] = ["tap", "type", "assert"];

/**
 * IntroLoader — full-viewport brand intro shown while Podium Studio's local engine connects.
 *
 * Tells the product's own loop in one orchestrated beat, using the device mirror the QA
 * actually works in every day:
 *   1. A device frame wakes up.
 *   2. A tap lands and ripples outward — Record.
 *   3. Tap / Type / Verify cascade to a green check, one by one — Run.
 *   4. The device resolves into the Auto-P mark + wordmark — Trace (pass).
 *   5. The whole thing fades, `onDone` fires.
 *
 * The choreography is pure CSS (transform/opacity + stroke-dashoffset keyframes with staggered
 * `animation-delay`), so mounting this component is enough to play the whole sequence — no
 * per-frame JS. The only two timers here trigger the container's exit-fade and the `onDone`
 * callback; both are cleared on unmount so nothing can fire after this component is gone.
 *
 * `prefers-reduced-motion` is honored twice: the CSS (see intro-loader.css) collapses every
 * keyframe to its resolved end-state so reduced-motion users see a calm, static composition,
 * and the JS timeline below is shortened to match so the fade+onDone still happens quickly.
 */
export default function IntroLoader({ onDone }: IntroLoaderProps) {
  const t = useT();
  const STEP_LABELS: Record<StepId, string> = {
    tap: t("intro.stepTap"),
    type: t("intro.stepType"),
    assert: t("intro.stepVerify"),
  };
  const [exiting, setExiting] = useState(false);
  const timers = useRef<number[]>([]);
  // Keep the latest onDone without re-running the mount effect if the parent passes a new
  // closure on every render.
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  useEffect(() => {
    const reduced =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Normal motion: let the full ~2.6s CSS choreography (see intro-loader.css) play out before
    // fading. Reduced motion: the CSS shows the resolved end-state immediately, so just hold
    // briefly and fade — still a deliberate transition, never an abrupt cut.
    const exitAt = reduced ? 900 : 2350;
    const doneAt = reduced ? 1150 : 2650;

    timers.current.push(
      window.setTimeout(() => {
        setExiting(true);
      }, exitAt),
    );
    timers.current.push(
      window.setTimeout(() => {
        onDoneRef.current?.();
      }, doneAt),
    );

    return () => {
      for (const id of timers.current) window.clearTimeout(id);
      timers.current = [];
    };
  }, []);

  return (
    <div
      className={`intro-loader${exiting ? " intro-loader--exit" : ""}`}
      role="status"
      aria-live="polite"
    >
      <span className="intro-sr-only">{t("intro.srStarting")}</span>

      <div className="intro-loader__aurora" aria-hidden="true">
        <span className="intro-blob intro-blob--a" />
        <span className="intro-blob intro-blob--b" />
        <span className="intro-blob intro-blob--c" />
        <span className="intro-stars" />
      </div>

      <div className="intro-stage" aria-hidden="true">
        <div className="intro-stage__device">
          <div className="intro-phone">
            <div className="intro-phone__notch" />
            <div className="intro-phone__screen">
              <span className="intro-tap-dot" />
              <span className="intro-ripple" />

              <ul className="intro-steps">
                {STEP_IDS.map((id) => (
                  <li className="intro-step" key={id}>
                    <span className="intro-step__glyph">
                      <StepGlyph id={id} />
                    </span>
                    <span className="intro-step__label">{STEP_LABELS[id]}</span>
                    <span className="intro-step__check">
                      <svg viewBox="0 0 14 14" className="intro-check-svg">
                        <path className="intro-check-path" d="M3.2 7.3 L6 10.1 L10.8 4.3" />
                      </svg>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        <div className="intro-stage__brand">
          <svg className="intro-mark" viewBox="0 0 512 512" focusable="false">
            <path className="intro-mark__loop" d="M 314 98 A 168 168 0 1 1 198 98" fill="none" />
            <path className="intro-mark__arrow" d="M 220 90 L 199 114 L 189 85 Z" />
            <path
              className="intro-mark__p"
              fill="none"
              d="M 198 350 C 191 280 192 214 197 170 C 256 160 313 174 314 226 C 315 274 256 289 201 280"
            />
          </svg>
          <p className="intro-wordmark">{t("app.title")}</p>
          <p className="intro-tagline">{t("intro.tagline")}</p>
        </div>
      </div>
    </div>
  );
}

/** Minimal line glyphs for each step row — deliberately abstract (a tap target, a text caret,
 * an inspection eye) rather than literal icon-font glyphs, so they read at 14px without a font
 * dependency. Color/stroke are set entirely in CSS (never as SVG presentation attributes) so
 * they can't fight the stylesheet's cascade. */
function StepGlyph({ id }: { id: StepId }) {
  if (id === "tap") {
    return (
      <svg viewBox="0 0 14 14">
        <circle className="intro-glyph-ring" cx="7" cy="7" r="5" />
        <circle className="intro-glyph-dot" cx="7" cy="7" r="1.5" />
      </svg>
    );
  }
  if (id === "type") {
    return (
      <svg viewBox="0 0 14 14">
        <line className="intro-glyph-ring" x1="5" y1="3" x2="5" y2="11" />
        <line className="intro-glyph-ring" x1="8" y1="5" x2="11" y2="5" />
        <line className="intro-glyph-ring" x1="8" y1="9" x2="11" y2="9" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 14 14">
      <ellipse className="intro-glyph-ring" cx="7" cy="7" rx="5" ry="3" />
      <circle className="intro-glyph-dot" cx="7" cy="7" r="1.4" />
    </svg>
  );
}
