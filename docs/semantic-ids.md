# Semantic IDs

`newSemanticId(kind)` returns `<kind>-<word>-<word>-<word>`, for example
`agent-access-action-active`. The three words are different from each other and come from a fixed,
sorted list of 500 English words. Readable IDs are for things people and models refer to. Internal
request IDs and digests do not need them.

| Prefix | Names |
| --- | --- |
| `agent` | A running agent |
| `message` | A routed message |
| `process` | A background process |
| `goal` | A goal |
| `wait` | A wait for a child's answer |
| `artifact` | Collected workspace files |
| `task` | A goal criterion |
| `tool` | Reserved; not generated yet |

IDs are not reserved or checked against each other, so two calls can return the same ID. Code that
needs uniqueness must rely on who owns the ID and where it is used. The main agent's ID is saved
for resume. Each child gets a new one. Operating-system process IDs and Pi session IDs are separate.

Source: [generator](../packages/pi-runtime/src/semantic-id.ts), [word list](../packages/pi-runtime/src/semantic-words.ts) and [tests](../packages/pi-runtime/test/semantic-id.test.ts).

## Token counts

A word can encode differently on its own than after `-` or a space. In OpenAI's `o200k_base`
encoding, all 500 words are one token after `-` and after a space; 467 are also one token on their
own. A whole ID is not three tokens: `agent-access-action-active` is four.

This was checked with `tiktoken` 0.14.0 and the official
[encoding definition](https://github.com/openai/tiktoken/blob/main/tiktoken_ext/openai_public.py),
with the [BPE file](https://openaipublic.blob.core.windows.net/encodings/o200k_base.tiktoken)
pinned to SHA-256:

```text
446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d
```

These counts apply only to that file, these spellings and those two contexts. They say nothing
about other tokenizers, including DeepSeek's and Claude's, or future versions. The word list is
fixed data; there is no tokenizer dependency at runtime.
