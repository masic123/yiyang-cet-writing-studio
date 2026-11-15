"use client";
import { useState } from "react";
import { UsersThree } from "@phosphor-icons/react";
export default function OfficialGroup({ compact = false }: { compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  return <button type="button" className={`official-group${compact ? " official-group-header" : ""}`} aria-label={copied ? "官方群号1059633594已复制" : "复制官方QQ群1059633594"} title={copied ? "群号已复制：1059633594" : "官方QQ群：1059633594，点击复制"} onClick={async () => {
    try { await navigator.clipboard.writeText("1059633594"); setCopied(true); }
    catch { setCopied(false); }
  }}><UsersThree size={17} /><span>{copied ? "已复制" : compact ? "官方群" : "官方 QQ 群"}{!compact && <b>1059633594</b>}</span></button>;
}
