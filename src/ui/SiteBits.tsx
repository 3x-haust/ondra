// Sites shown by their own icons: the few a job's browser opened (overlapping, beside its row) and
// the links a message carries (small cards under it). Icons and titles come from the pages
// themselves (link_card, through the same cache as the link cards in replies).
import { createResource, For, Show } from "solid-js";
import { cardOf } from "./linkCard";
import { openLink } from "./links";
import { shortUrl, urlsIn } from "../lib/links";

/** `letter`: until (or unless) the site has an icon, its first letter stands in */
function SiteIcon(props: { url: string; host: string; letter?: boolean }) {
  const [card] = createResource(() => props.url, cardOf);
  return (
    <Show when={card()?.icon} fallback={props.letter && <span class="site-ico site-letter">{props.host.replace(/^www\./, "")[0]?.toUpperCase()}</span>}>
      {(src) => <img class="site-ico" src={src()} alt="" draggable={false} />}
    </Show>
  );
}

/** up to four sites' icons, overlapping; only sites that have one (the names stay the words beside it) */
export function SiteIcons(props: { hosts: string[] }) {
  const shown = () => [...new Set(props.hosts.map((h) => h.toLowerCase()).filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)))].slice(0, 4);
  return (
    <Show when={shown().length}>
      <span class="site-icons" aria-hidden="true">
        <For each={shown()}>{(h) => <SiteIcon url={`https://${h}`} host={h} />}</For>
      </span>
    </Show>
  );
}

function LinkChip(props: { url: string }) {
  const [card] = createResource(() => props.url, cardOf);
  const where = () => shortUrl(props.url);
  return (
    <button class="link-chip" title={props.url} onClick={(e) => openLink(props.url, { event: e })}>
      <SiteIcon url={props.url} host={where().host} letter />
      <span class="link-chip-text">
        <span class="link-chip-title">{card()?.title || where().host + where().rest}</span>
        <Show when={card()?.title}><span class="link-chip-host">{card()?.site || where().host}</span></Show>
      </span>
    </button>
  );
}

/** the web links in a message, as small cards */
export function LinkChips(props: { text: string }) {
  const urls = () => urlsIn(props.text);
  return (
    <Show when={urls().length}>
      <div class="link-chips">
        <For each={urls()}>{(u) => <LinkChip url={u} />}</For>
      </div>
    </Show>
  );
}
