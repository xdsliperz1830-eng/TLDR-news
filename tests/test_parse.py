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
    assert stories[1]["title"] == "Ship AI Faster With Acme"

    repo = stories[2]
    assert repo["kind"] == "github repo"
    assert repo["title"] == "foo/bar"
    assert repo["section"] == "Engineering & Research"


if __name__ == "__main__":
    test_parse_issue()
    print("ok")
