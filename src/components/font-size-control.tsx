"use client";

import { useEffect, useState } from "react";
import { ArrowCounterClockwise, Minus, Plus, TextAa } from "@phosphor-icons/react";
import { Modal } from "./ui";
import {
  DEFAULT_FONT_SIZE, FONT_SIZE_KEY, MAX_FONT_SIZE, MIN_FONT_SIZE,
  fontSizePercentage, normalizeFontSize,
} from "@/lib/font-size";

export default function FontSizeControl() {
  const [open, setOpen] = useState(false);
  const [size, setSize] = useState(DEFAULT_FONT_SIZE);
  const [draft, setDraft] = useState(String(DEFAULT_FONT_SIZE));
  const [saved, setSaved] = useState(true);

  useEffect(() => {
    const sync = () => {
      let value = DEFAULT_FONT_SIZE;
      try { value = normalizeFontSize(localStorage.getItem(FONT_SIZE_KEY)); } catch {}
      setSize(value);
      setDraft(String(value));
      document.documentElement.style.setProperty("--app-font-size", fontSizePercentage(value));
    };
    sync();
    const onStorage = (event: StorageEvent) => {
      if (event.key === FONT_SIZE_KEY || event.key === null) sync();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function change(value: number) {
    const next = normalizeFontSize(Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(value))));
    setSize(next);
    setDraft(String(next));
    document.documentElement.style.setProperty("--app-font-size", fontSizePercentage(next));
    try { localStorage.setItem(FONT_SIZE_KEY, String(next)); setSaved(true); }
    catch { setSaved(false); }
  }

  return (
    <>
      <button type="button" className="font-size-trigger" onClick={() => setOpen(true)} aria-label="调整字号" aria-haspopup="dialog">
        <TextAa size={20} aria-hidden="true" />
        <span>字号</span>
      </button>
      <Modal open={open} onOpenChange={setOpen} title="调整字号" description="题目、正文、批改报告和界面文字会一起调整，立即生效。">
        <div className="font-size-settings">
          <div className="font-size-heading">
            <label htmlFor="reading-font-size">基础字号</label>
            <output htmlFor="reading-font-size" aria-live="polite">{size}<span>px</span></output>
          </div>
          <div className="font-size-slider-row">
            <button type="button" className="icon-button" aria-label="缩小字号" disabled={size === MIN_FONT_SIZE} onClick={() => change(size - 1)}><Minus size={20} /></button>
            <input id="reading-font-size" type="range" min={MIN_FONT_SIZE} max={MAX_FONT_SIZE} step={1} value={size} aria-valuetext={`${size} 像素`} onChange={(event) => change(Number(event.target.value))} />
            <button type="button" className="icon-button" aria-label="放大字号" disabled={size === MAX_FONT_SIZE} onClick={() => change(size + 1)}><Plus size={20} /></button>
          </div>
          <div className="font-size-custom">
            <label htmlFor="reading-font-size-number">自定义字号</label>
            <div>
              <input id="reading-font-size-number" type="number" min={MIN_FONT_SIZE} max={MAX_FONT_SIZE} step={1} inputMode="numeric" value={draft}
                onChange={(event) => {
                  const value = event.target.value;
                  setDraft(value);
                  if (value && Number.isInteger(Number(value)) && Number(value) >= MIN_FONT_SIZE && Number(value) <= MAX_FONT_SIZE) change(Number(value));
                }}
                onBlur={() => change(draft.trim() && Number.isFinite(Number(draft)) ? Number(draft) : size)} />
              <span>px</span>
            </div>
          </div>
          <div className="font-size-presets" role="group" aria-label="常用字号">
            {[{ value: 18, label: "标准" }, { value: 20, label: "较大" }, { value: 22, label: "更大" }].map((preset) => (
              <button key={preset.value} type="button" aria-pressed={size === preset.value} onClick={() => change(preset.value)}>{preset.label}<span>{preset.value}</span></button>
            ))}
          </div>
          <div className="font-size-preview" aria-label="字号预览">
            <span>阅读预览</span>
            <p>把想法写清楚，每一次练习都看得更舒服。</p>
            <p lang="en">Clear ideas make good writing.</p>
          </div>
          <div className="font-size-settings-footer">
            <button type="button" className="text-button" onClick={() => change(DEFAULT_FONT_SIZE)}><ArrowCounterClockwise size={16} />恢复默认</button>
            <p className="muted" role="status">{saved ? "自动保存在此浏览器" : "浏览器暂不允许保存，当前设置仍然生效"}</p>
          </div>
        </div>
      </Modal>
    </>
  );
}
