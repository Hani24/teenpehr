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


# ---- glossary (#7) ------------------------------------------------------------------------------
def _g(term_en, term_ur, locked=False):
    from teenpehr.models import GlossaryEntry

    return GlossaryEntry(term_en=term_en, term_ur=term_ur, locked=locked)


def test_glossary_locked_entries_always_included_and_mandatory():
    from teenpehr.render import render_glossary

    entries = [_g(f"Unlocked {i}", "غیر") for i in range(10)] + [
        _g(f"Locked {i}", "لاک", locked=True) for i in range(5)
    ]
    text = render_glossary(entries, limit=3)
    locked, suggested = text.split("Suggested (not yet reviewed):")
    assert locked.startswith("Locked (mandatory):") and all(f"Locked {i} →" in locked for i in range(5))
    assert suggested.strip() == "(none)"  # the cap is spent on locked entries, which are never dropped
    text = render_glossary(entries, limit=7)
    assert text.count("Unlocked") == 2


def test_glossary_suggestions_are_only_the_names_the_stories_mention():
    from teenpehr.render import render_glossary

    entries = [_g("Dawn", "ڈان"), _g("Karachi", "کراچی"), _g("Reuters", "رائٹرز", locked=True)]
    text = render_glossary(entries, text="Rain at dawn in Karachi. Outlets: Geo")
    assert "Karachi → کراچی" in text and "Dawn →" not in text  # whole word, case-sensitive
    assert "Reuters → رائٹرز" in text  # locked: always


def test_urdu_input_carries_the_thread_title():
    from teenpehr.models import SourceRef, StoryIn
    from teenpehr.render import render_stories_for_urdu

    st = StoryIn(
        order=0, thread="x", thread_title_en="IMF review", title_en="T", summary_en="S", sources=[SourceRef(item_id=1)]
    )
    assert "Thread title: IMF review" in render_stories_for_urdu("Lead", [st], {1: "Dawn"})


# ---- Claude runs on the Claude Code login, never an API key (owner decision, docs/PLAN.md) ---------------
def _result(structured, cost=0.02):
    import claude_agent_sdk

    return claude_agent_sdk.ResultMessage(
        subtype="success",
        duration_ms=1,
        duration_api_ms=1,
        is_error=False,
        num_turns=1,
        session_id="s",
        total_cost_usd=cost,
        usage={"input_tokens": 10, "output_tokens": 5},
        structured_output=structured,
    )


async def test_claude_llm_blanks_api_keys_for_the_cli_and_uses_the_login(monkeypatch):
    """A key in the worker's environment must never reach the CLI (it would bill the API instead of the
    subscription): every billing switch is handed to the CLI as "", and no token is invented."""
    import claude_agent_sdk

    from teenpehr.llm import BLANKED_ENV, NO_CONNECTORS_ENV, ClaudeLLM
    from teenpehr.models import QaOut

    seen = {}

    async def fake_query(*, prompt, options):
        seen["env"], seen["prompt"] = options.env, prompt
        yield _result({"stories": []})

    monkeypatch.setattr(claude_agent_sdk, "query", fake_query)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-stray")
    res = await ClaudeLLM().structured(
        task="qa:x", system="s", user="u", schema=QaOut, model="claude-haiku-4-5", max_budget_usd=0.1
    )
    assert seen["env"] == {**dict.fromkeys(BLANKED_ENV, ""), **NO_CONNECTORS_ENV} and "ANTHROPIC_API_KEY" in BLANKED_ENV
    assert "CLAUDE_CODE_OAUTH_TOKEN" not in seen["env"] and seen["prompt"] == "u" and res.cost_usd == 0.02


async def test_claude_llm_passes_a_setup_token_through(monkeypatch):
    import claude_agent_sdk

    from teenpehr.llm import ClaudeLLM
    from teenpehr.models import QaOut

    seen = {}

    async def fake_query(*, prompt, options):
        seen["env"] = options.env
        yield _result({"stories": []})

    monkeypatch.setattr(claude_agent_sdk, "query", fake_query)
    await ClaudeLLM(oauth_token="oat-1").structured(
        task="qa:x", system="s", user="u", schema=QaOut, model="m", max_budget_usd=0.1
    )
    assert seen["env"]["CLAUDE_CODE_OAUTH_TOKEN"] == "oat-1" and seen["env"]["ANTHROPIC_API_KEY"] == ""


async def test_claude_llm_loads_no_mcp_server_and_no_claude_ai_connector(monkeypatch):
    """Signed in to claude.ai, the CLI would otherwise load the account's connectors (mail, docs,
    trading, ...) as tools beside prompts built from untrusted articles: every call starts with none."""
    import claude_agent_sdk

    from teenpehr.llm import ClaudeLLM
    from teenpehr.models import QaOut

    seen = {}

    async def fake_query(*, prompt, options):
        seen["options"] = options
        yield _result({"stories": []})

    monkeypatch.setattr(claude_agent_sdk, "query", fake_query)
    await ClaudeLLM().structured(task="qa:x", system="s", user="u", schema=QaOut, model="m", max_budget_usd=0.1)
    o = seen["options"]
    assert o.env["ENABLE_CLAUDEAI_MCP_SERVERS"] == "false"
    assert "strict-mcp-config" in o.extra_args and o.mcp_servers == {}
    assert o.tools == [] and o.setting_sources == [] and o.permission_mode == "dontAsk"


async def test_claude_llm_sends_images_as_base64_content_blocks_with_tools_off(monkeypatch):
    """The vision check's image goes in the streamed user message (stream-json input), never as a file
    or a URL, and the call still has no tools."""
    import base64

    import claude_agent_sdk

    from teenpehr.llm import ClaudeLLM, ImageBlock
    from teenpehr.models import ImageCheckOut

    seen = {}

    async def fake_query(*, prompt, options):
        seen["messages"] = [m async for m in prompt]
        seen["tools"] = options.tools
        yield _result({"graphic": False, "placeholder_or_logo": False}, cost=0.002)

    monkeypatch.setattr(claude_agent_sdk, "query", fake_query)
    res = await ClaudeLLM().structured(
        task="image:pk:0",
        system="s",
        user="Check this image.",
        schema=ImageCheckOut,
        model="claude-haiku-4-5",
        max_budget_usd=0.05,
        images=[ImageBlock("image/webp", b"RIFF1234WEBPdata")],
    )
    (msg,) = seen["messages"]
    assert msg["type"] == "user" and msg["message"]["role"] == "user"
    img, text = msg["message"]["content"]
    assert img["type"] == "image" and img["source"]["type"] == "base64" and img["source"]["media_type"] == "image/webp"
    assert base64.b64decode(img["source"]["data"]) == b"RIFF1234WEBPdata"
    assert text == {"type": "text", "text": "Check this image."}
    assert seen["tools"] == [] and res.output.graphic is False


def test_auth_status_asks_the_cli_locally_with_keys_blanked(monkeypatch):
    import json
    import subprocess

    from teenpehr import llm

    seen = {}

    def fake_run(cmd, *, env, **kw):
        seen["cmd"], seen["env"] = cmd, env
        out = {"loggedIn": True, "authMethod": "claude.ai", "apiProvider": "firstParty", "subscriptionType": "max"}
        return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps(out), stderr="")

    monkeypatch.setattr(llm, "cli_path", lambda: "/opt/claude")
    monkeypatch.setattr(llm.subprocess, "run", fake_run)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-stray")
    monkeypatch.setenv("CLAUDECODE", "1")
    st = llm.auth_status()
    assert seen["cmd"] == ["/opt/claude", "auth", "status", "--json"]
    assert seen["env"]["ANTHROPIC_API_KEY"] == "" and "CLAUDECODE" not in seen["env"]
    assert st == {
        "auth_mode": "login",
        "logged_in": True,
        "auth_method": "claude.ai",
        "api_provider": "firstParty",
        "subscription": "max",
    }


def test_auth_problem_when_signed_out_or_the_cli_is_missing(monkeypatch):
    import json
    import subprocess

    from teenpehr import llm

    monkeypatch.setattr(llm, "cli_path", lambda: "/opt/claude")
    monkeypatch.setattr(
        llm.subprocess,
        "run",
        lambda cmd, **kw: subprocess.CompletedProcess(cmd, 0, stdout=json.dumps({"loggedIn": False}), stderr=""),
    )
    assert llm.ClaudeLLM().auth_problem() == llm.NOT_SIGNED_IN
    assert llm.auth_status(oauth_token="t")["auth_mode"] == "oauth_token"
    monkeypatch.setattr(llm, "cli_path", lambda: None)
    assert "no Claude Code CLI" in llm.ClaudeLLM().auth_problem()
