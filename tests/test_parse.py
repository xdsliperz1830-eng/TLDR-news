import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scraper"))
from scrape import parse_issue  # noqa: E402

HTML = (Path(__file__).parent / "fixtures" / "ai-sample.html").read_text()


def test_parse_issue():
    stories = parse_issue(HTML, "ai", "2026-10-02")
    assert len(stories) == 3

    first = stories[0]
    assert first["title"] == "New Model Beats Benchmarks"
    assert first["read_minutes"] == 4
    assert first["section"] == "Headlines & Launches"
    assert first["summary"] == "A lab released a model that tops several benchmarks."
    assert not first["sponsored"]

    assert stories[1]["sponsored"]
    assert stories[1]["url"] == "https://sponsor.example.com/?a=1&utm_campaign=sponsor"
    assert stories[1]["title"] == "Ship AI Faster With Acme"

    repo = stories[2]
    assert repo["kind"] == "github repo"
    assert repo["title"] == "foo/bar"
    assert repo["section"] == "Engineering & Research"




def test_story_key():
    from scrape import story_key
    a = story_key("https://www.example.com/post/?utm_source=tldrai&sp=1#top")
    b = story_key("https://example.com/post?utm_source=tldrwebdev")
    assert a == b == "https://example.com/post"
    # Real query parameters are kept.
    assert story_key("https://youtube.com/watch?v=abc&utm_medium=email") == "https://youtube.com/watch?v=abc"


def test_last_weekday_before():
    import datetime as dt
    from scrape import last_weekday_before
    assert last_weekday_before(dt.date(2026, 10, 5)) == dt.date(2026, 10, 2)  # Monday -> Friday
    assert last_weekday_before(dt.date(2026, 10, 7)) == dt.date(2026, 10, 6)


if __name__ == "__main__":
    test_parse_issue()
    test_story_key()
    test_last_weekday_before()
    print("ok")
