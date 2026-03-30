type HuggingFaceModelApiRecord = {
  id?: string;
};

type GitHubContentRecord = {
  name?: string;
  type?: string;
};

const HUGGINGFACE_MODELS_API_URL =
  "https://huggingface.co/api/models?author=mlc-ai&limit=200&sort=lastModified&direction=-1";
const BINARY_LIBS_API_URL =
  "https://api.github.com/repos/mlc-ai/binary-mlc-llm-libs/contents/web-llm-models/v0_2_80";

function normalizeModelKey(value: string) {
  return value
    .replace(/^mlc-ai\//, "")
    .replace(/-MLC$/i, "")
    .replace(/-ctx.*$/i, "")
    .replace(/-webgpu$/i, "")
    .replace(/[^a-z0-9]/gi, "")
    .toLowerCase();
}

async function fetchBinaryLibEntries() {
  const response = await fetch(BINARY_LIBS_API_URL, {
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`Binary lib list failed with ${response.status}`);
  }

  return (await response.json()) as GitHubContentRecord[];
}

export async function fetchHuggingFaceMLCModels() {
  const [hfResponse, binaryLibEntries] = await Promise.all([
    fetch(HUGGINGFACE_MODELS_API_URL, {
      headers: {
        Accept: "application/json",
      },
    }),
    fetchBinaryLibEntries(),
  ]);

  if (!hfResponse.ok) {
    throw new Error(`Hugging Face model list failed with ${hfResponse.status}`);
  }

  const availableBinaryKeys = new Set(
    binaryLibEntries
      .filter((entry) => entry.type === "file" && entry.name?.endsWith(".wasm"))
      .map((entry) => normalizeModelKey(entry.name || "")),
  );

  const payload = (await hfResponse.json()) as HuggingFaceModelApiRecord[];
  return payload
    .map((entry) => entry.id?.trim())
    .filter((id): id is string => Boolean(id) && id.includes("-MLC"))
    .map((id) => id.replace(/^mlc-ai\//, ""))
    .filter((id) => availableBinaryKeys.has(normalizeModelKey(id)));
}
