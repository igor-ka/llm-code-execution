"""The network tool must refuse anything that isn't the local target."""
import pytest

from secagent.agent_core.tools import LoopbackHTTP, NonLoopbackTarget


def test_rejects_non_loopback_host():
    with pytest.raises(NonLoopbackTarget):
        LoopbackHTTP("http://evil.example.com:8000")


@pytest.mark.parametrize("url", ["http://127.0.0.1:8000", "http://localhost:8000"])
def test_allows_loopback(url):
    assert LoopbackHTTP(url).base_url == url


def test_operator_can_allow_a_known_local_host():
    # e.g. a compose service name — an operator choice, never the model's.
    http = LoopbackHTTP("http://backend:8000", extra_allowed_hosts={"backend"})
    assert http.base_url == "http://backend:8000"
