from datetime import UTC, datetime

from teenpehr.llm import usage_tokens
from teenpehr.pipeline import latin_words
from teenpehr.render import NumberedItem, render_item, render_items


def _item(title, text, idx=1):
    return NumberedItem(
        idx=idx,
        kind="article",
        db_id=idx,
        title=title,
        text=text,
        source_name="Dawn",
        perspective="liberal",
        published=datetime(2026, 9, 23, tzinfo=UTC),
    )


def test_item_title_plus_text_capped_at_400():
    it = _item("T" * 150, "x " * 600)
    line = render_item(it, now=datetime(2026, 9, 23, 1, tzinfo=UTC))
    payload = line.split(") ", 1)[1]
    assert len(payload) <= 400 and payload.startswith("T" * 150 + " -- ")
    assert payload.endswith("…")


def test_title_capped_at_200_and_text_fills_the_rest():
    it = _item("T" * 380, "some text here " * 40)
    payload = render_item(it).split(") ", 1)[1]
    assert payload.startswith("T" * 199 + "… -- ") and len(payload) <= 400


def test_no_text_when_budget_under_40_chars():
    it = _item("T" * 200, "abc")
    assert render_item(it, max_chars=230).split(") ", 1)[1] == "T" * 200


def test_text_identical_to_title_is_not_repeated():
    it = _item("PM chairs meeting", "PM chairs meeting")
    assert " -- " not in render_item(it)


def test_render_items_uncapped_is_longer():
    items = [_item("Title", "word " * 300, idx=i) for i in range(1, 4)]
    assert len(render_items(items, max_chars=100_000)) > len(render_items(items))


def test_usage_tokens_snake_and_camel():
    u = {"input_tokens": 100, "output_tokens": 20, "cache_read_input_tokens": 1000, "cache_creation_input_tokens": 50}
    assert usage_tokens(u, None) == {"input": 100, "cache_read": 1000, "cache_write": 50, "in": 1150, "out": 20}
    mu = {
        "claude-sonnet-5": {
            "inputTokens": 7,
            "outputTokens": 3,
            "cacheReadInputTokens": 90,
            "cacheCreationInputTokens": 0,
        }
    }
    assert usage_tokens(None, mu)["in"] == 97 and usage_tokens({}, mu)["out"] == 3
    assert usage_tokens(None, None)["in"] == 0


def test_latin_words_detects_outlet_names():
    assert latin_words("ڈان، جیو اور Express Tribune کے مطابق") == ["Express Tribune"]
    assert latin_words("آئی ایم ایف نے 7 ارب ڈالر") == []
    assert latin_words("PTI نے کہا") == ["PTI"]  # acronyms must be Urdu too (پی ٹی آئی)
