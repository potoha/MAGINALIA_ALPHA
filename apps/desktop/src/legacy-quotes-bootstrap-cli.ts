import { bootstrapLegacyQuotes } from "./legacy-quotes-bootstrap";

interface Arguments {
  readonly sourceRoot: string;
  readonly shelfRoot: string;
  readonly shelfName?: string;
}

function parseArguments(argumentsList: readonly string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    const value = argumentsList[index + 1];
    if ((flag !== "--source" && flag !== "--destination" && flag !== "--shelf-name") || value === undefined || values.has(flag)) {
      throw new Error("Usage: legacy-quotes-bootstrap --source <legacy_quotes> --destination <private-shelf> [--shelf-name <name>]");
    }
    values.set(flag, value);
  }
  const sourceRoot = values.get("--source");
  const shelfRoot = values.get("--destination");
  if (sourceRoot === undefined || shelfRoot === undefined) {
    throw new Error("Usage: legacy-quotes-bootstrap --source <legacy_quotes> --destination <private-shelf> [--shelf-name <name>]");
  }
  return { sourceRoot, shelfRoot, ...(values.has("--shelf-name") ? { shelfName: values.get("--shelf-name") } : {}) };
}

async function main(): Promise<void> {
  const result = await bootstrapLegacyQuotes(parseArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (result.pending.length > 0 || result.conflicts > 0) process.exitCode = 2;
}

void main().catch((error: unknown) => {
  process.stderr.write(`H.6R4 legacy quote bootstrap failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
