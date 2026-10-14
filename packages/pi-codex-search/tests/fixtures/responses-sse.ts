/** Redacted structure copied from the v0.1.6 Responses parser fixture contract. */
export const responsesFixture = [
  'event: response.created\r\ndata: {"response":{"id":"resp_fixture_01"}}\r\n\r\n',
  'event: response.output_item.added\r\ndata: {"item":{"id":"ws_fixture_01","type":"web_search_call","status":"in_progress"}}\r\n\r\n',
  'event: response.output_text.delta\r\ndata: {"delta":"Fixture answer with a source."}\r\n\r\n',
  'event: response.output_item.done\r\ndata: {"item":{"id":"ws_fixture_01","type":"web_search_call","status":"completed","action":{"type":"search","query":"fixture source query"}}}\r\n\r\n',
  'event: response.output_item.done\r\ndata: {"item":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Fixture answer with a source.","annotations":[{"type":"url_citation","title":"Fixture Source","url":"https://example.com/source","start_index":26,"end_index":39}]}]}}\r\n\r\n',
  'event: response.completed\r\ndata: {"response":{"usage":{"input_tokens":12,"output_tokens":7,"total_tokens":19}}}\r\n\r\n',
  "data: [DONE]\r\n\r\n",
].join("");

export function chunk(text: string, sizes: number[]): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  let offset = 0;
  for (const size of sizes) {
    if (offset >= bytes.length) break;
    chunks.push(bytes.slice(offset, offset + size));
    offset += size;
  }
  if (offset < bytes.length) chunks.push(bytes.slice(offset));
  return chunks;
}

export function streamFrom(
  chunks: Uint8Array[],
  onCancel?: () => void,
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index++]!);
    },
    cancel() {
      onCancel?.();
    },
  });
}
