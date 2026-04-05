export function createHeader(blessed, screen) {
  return blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: "100%",
    height: 1,
    tags: true,
    content: "{bold}Terminal llama.cpp LLM{/bold}",
    style: {
      fg: "white",
      bg: "blue",
    },
  });
}
