import { ArrowSquareOut } from "@phosphor-icons/react";

export default function FriendSiteLink() {
  return (
    <a className="friend-site-link" href="https://ssbyielt.xyz/" target="_blank" rel="noopener noreferrer">
      <span>友站：<strong>莎试笔雅</strong></span>
      <ArrowSquareOut size={14} aria-hidden="true" />
    </a>
  );
}
