/**
 * Gemini API wrappers for text embedding and VLM (Vision Language Model).
 * Used in "fast" and "vlm" modes when user provides a Gemini API key.
 */

const EMBEDDING_URL = "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent";
const VLM_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent";

/**
 * Get a 768-dim text embedding from Gemini text-embedding-004.
 */
export async function getEmbedding(text: string, apiKey: string): Promise<number[]> {
  const resp = await fetch(`${EMBEDDING_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: { parts: [{ text: text.slice(0, 8000) }] },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini embedding error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  return data.embedding.values as number[];
}

/**
 * Batch embed multiple texts. Gemini doesn't have a native batch endpoint,
 * so we send requests in parallel with rate limiting.
 */
export async function batchEmbed(
  texts: string[],
  apiKey: string,
  batchSize = 10,
  onProgress?: (done: number, total: number) => void,
): Promise<number[][]> {
  const results: number[][] = [];

  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const embeddings = await Promise.all(
      batch.map((t) => getEmbedding(t, apiKey))
    );
    results.push(...embeddings);
    onProgress?.(Math.min(i + batchSize, texts.length), texts.length);

    // Small delay between batches to respect rate limits
    if (i + batchSize < texts.length) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  return results;
}

/**
 * Use Gemini 2.0 Flash with vision to describe what file a webpage is asking for.
 * Takes a screenshot (base64) and context text, returns a descriptive string.
 */
export async function describeWithVLM(
  imageBase64: string,
  contextText: string,
  apiKey: string,
): Promise<string> {
  const resp = await fetch(`${VLM_URL}?key=${apiKey}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{
        parts: [
          {
            inlineData: {
              mimeType: "image/png",
              data: imageBase64,
            },
          },
          {
            text: `You are analyzing a webpage screenshot showing a file upload area. The surrounding text context is: "${contextText.slice(0, 500)}"\n\nDescribe in 2-3 sentences what type of file this upload field is asking the user to provide. Be specific about the document type (e.g., passport, resume, transcript, photo ID, tax form, etc.). Focus on keywords that would help match against file names and content.`,
          },
        ],
      }],
      generationConfig: {
        maxOutputTokens: 200,
        temperature: 0.2,
      },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Gemini VLM error ${resp.status}: ${err}`);
  }

  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return text;
}
