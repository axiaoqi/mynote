from __future__ import annotations

import html
import re
from html.parser import HTMLParser

import bleach


ALLOWED_TAGS = {
    "p", "div", "br", "h1", "h2", "h3", "strong", "b", "em", "i",
    "u", "s", "strike", "ul", "ol", "li", "blockquote", "a", "img",
    "span", "pre", "code",
}


def _allowed_attribute(tag: str, name: str, value: str) -> bool:
    if name in {"class", "data-list", "data-checked"}:
        return True
    if tag == "a" and name in {"href", "title", "target", "rel"}:
        return True
    if tag == "img" and name in {"src", "alt", "title", "data-attachment-id"}:
        return True
    return False


class _TextExtractor(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)

    def handle_starttag(self, tag: str, attrs) -> None:
        if tag in {"br", "p", "div", "li", "h1", "h2", "h3", "blockquote"}:
            self.parts.append("\n")


def sanitize_html(value: str | None) -> str:
    cleaned = bleach.clean(
        value or "",
        tags=ALLOWED_TAGS,
        attributes=_allowed_attribute,
        protocols={"http", "https", "mailto"},
        strip=True,
    )
    cleaned = bleach.linkify(
        cleaned,
        callbacks=[bleach.callbacks.nofollow, bleach.callbacks.target_blank],
        skip_tags={"pre", "code"},
    )
    return cleaned[:1_500_000]


def html_to_text(value: str | None) -> str:
    parser = _TextExtractor()
    parser.feed(value or "")
    text = html.unescape("".join(parser.parts))
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()[:500_000]


def plain_to_html(value: str) -> str:
    escaped = html.escape(value)
    paragraphs = [part.replace("\n", "<br>") for part in re.split(r"\n\s*\n", escaped)]
    return "".join(f"<p>{part}</p>" for part in paragraphs if part)


def safe_filename_part(value: str, fallback: str = "note") -> str:
    value = re.sub(r"[\\/:*?\"<>|\x00-\x1f]", "_", value).strip(" ._")
    return (value[:80] or fallback)
