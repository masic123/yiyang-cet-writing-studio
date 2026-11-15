"use client";

import { memo, useEffect, useRef, type RefObject } from "react";

const entrances = [
  ".practice-header", ".practice-switcher", ".question-panel", ".editor-panel",
  ".bank-intro", ".bank-corpus", ".question-card:not(.question-card-skeleton *)",
  ".history-view > .page-intro", ".history-row", ".empty",
  ".teacher-intro", ".teacher-room", ".notebook-view > .page-intro", ".notebook-summary",
  ".sentence-heading", ".sentence-card", ".supplementary-intro", ".material-article",
  ".report-view > .page-intro", ".score-overview",
].join(",");

// Native, one-shot motion: reading and typing never drive the React render loop.
// Nothing is hidden in CSS, so content remains usable before hydration or without JS.
function StudioMotion({ root, scene, questionKey }: {
  root: RefObject<HTMLDivElement | null>;
  scene: string;
  questionKey: string;
}) {
  const previous = useRef({ scene: "", questionKey: "" });

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const nav = element.querySelector<HTMLElement>(".sidebar nav");
    const tracks = element.querySelector<HTMLElement>(".track-tabs");
    function measure() {
      for (const [group, activeSelector, kind] of [
        [nav, ".nav-item.active", "nav"],
        [tracks, 'button[aria-pressed="true"]', "track"],
      ] as const) {
        if (!group) continue;
        const active = group.querySelector<HTMLElement>(activeSelector);
        if (!active || !group.getClientRects().length) {
          group.removeAttribute("data-motion-indicator");
          continue;
        }
        const box = group.getBoundingClientRect(), item = active.getBoundingClientRect();
        group.style.setProperty("--motion-x", `${item.left - box.left}px`);
        group.style.setProperty("--motion-y", `${kind === "nav" ? item.top - box.top : item.bottom - box.top - 3}px`);
        group.style.setProperty("--motion-width", `${item.width}px`);
        group.style.setProperty("--motion-height", `${item.height}px`);
        group.dataset.motionIndicator = kind;
      }
    }
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const resize = new ResizeObserver(measure);
    if (nav) resize.observe(nav);
    if (tracks) resize.observe(tracks);
    return () => resize.disconnect();
  }, [root, scene, questionKey]);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const questionOnly = previous.current.scene === scene && scene === "writer" && previous.current.questionKey !== questionKey;
    previous.current = { scene, questionKey };
    const selector = questionOnly
      ? ".question-panel > .question-title, .question-panel > .question-stem, .question-panel > .translation-source, .question-panel > .question-images"
      : entrances;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)");
    const animations = new Set<Animation>();
    const seen = new WeakSet<Element>();
    let intersection: IntersectionObserver | undefined;
    let mutations: MutationObserver | undefined;

    function stop() {
      intersection?.disconnect();
      mutations?.disconnect();
      animations.forEach(animation => animation.cancel());
      animations.clear();
    }
    function start() {
      if (reduce.matches || !element || typeof element.animate !== "function" || typeof IntersectionObserver === "undefined") return;
      const compact = matchMedia("(max-width: 767px)").matches;
      intersection = new IntersectionObserver(entries => {
        const visible = entries.filter(entry => entry.isIntersecting);
        visible.forEach((entry, index) => {
          intersection?.unobserve(entry.target);
          // A fast keyboard interaction should never move the focused control.
          if (entry.target.contains(document.activeElement)) return;
          const animation = entry.target.animate([
            { opacity: .12, translate: `0 ${compact ? 12 : 20}px` },
            { opacity: 1, translate: "0 0" },
          ], {
            duration: questionOnly ? 420 : compact ? 520 : 680,
            delay: Math.min(index, 3) * (compact ? 40 : 65),
            easing: "cubic-bezier(0.16, 1, 0.3, 1)",
            fill: "backwards",
          });
          animations.add(animation);
          animation.finished.then(() => { animations.delete(animation); animation.cancel(); }, () => animations.delete(animation));
        });
      }, { threshold: .08, rootMargin: "0px 0px -20px 0px" });
      function observe(candidate: Element) {
        if (seen.has(candidate) || candidate.closest("[hidden]")) return;
        // A panel and its children should not move twice at the same time.
        if (candidate.parentElement?.closest(selector)) return;
        seen.add(candidate);
        intersection?.observe(candidate);
      }
      element.querySelectorAll(selector).forEach(observe);
      mutations = new MutationObserver(records => {
        for (const record of records) for (const added of record.addedNodes) {
          if (!(added instanceof Element)) continue;
          if (added.matches(selector)) observe(added);
          added.querySelectorAll(selector).forEach(observe);
        }
      });
      mutations.observe(element.querySelector(".workspace") || element, { childList: true, subtree: true });
    }
    function preferenceChanged() { stop(); start(); }
    start();
    reduce.addEventListener("change", preferenceChanged);
    return () => { stop(); reduce.removeEventListener("change", preferenceChanged); };
  }, [root, scene, questionKey]);

  return null;
}

export default memo(StudioMotion);
