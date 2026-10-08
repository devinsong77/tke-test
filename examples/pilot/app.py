"""Small deterministic application used to demonstrate the release gate."""

def greeting(name: str) -> str:
    return f"Hello, {name.strip() or 'world'}!"
