// =============================================================================
// CLI Argument Parser for ingest subcommand
// =============================================================================

import type { IngestOptions, SplitInterval } from "./types";

const VALID_SPLITS = new Set(["1w", "2w", "1mo", "3mo", "1y"]);
const VALID_LAYOUTS = new Set(["by-period", "by-contact"]);
const VALID_MEDIA = new Set(["none", "audio", "images", "all"]);
const VALID_DATE_FORMATS = new Set(["DD/MM", "MM/DD"]);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const INGEST_HELP_TEXT = `
whatsapp-evidence ingest - Ingestão de exportações WhatsApp (.zip)

Uso:
  bun index.ts ingest [opções]

Opções:
  --input <dir>        Diretório com arquivos .zip (padrão: ./to-ingest/)
  --output <dir>       Diretório de saída (padrão: ./evidence/)
  --split <período>    Divisão temporal: 1w, 2w, 1mo, 3mo, 1y (padrão: 1w)
  --layout <tipo>      Organização: by-period, by-contact (padrão: by-period)
  --media <modo>       Processar mídia: none, audio, images, all (padrão: none)
  --media-since <data> Só mídias de mensagens a partir de AAAA-MM-DD
  --media-until <data> Só mídias de mensagens até AAAA-MM-DD (inclusive)
  --disclaimer         Incluir aviso legal OAB/CNJ
  --force              Pular confirmações interativas
  --self <nome>        Seu nome como aparece nos exports
  --timezone <tz>      Fuso horário IANA (padrão: America/Sao_Paulo)
  --date-format <fmt>  Forçar formato: DD/MM ou MM/DD
  --alias <de>=<para>  Unificar nomes (repetível)
  --concurrency <n>    Chamadas API paralelas (padrão: 3)
  --contact <nome>     Escopo para regeneração de contato específico
  --regenerate         Regenerar markdown a partir do índice
  --dry-run            Simular sem gravar nada em disco
  --quiet              Apenas erros
  --verbose            Nível de depuração
  -h, --help           Exibir esta mensagem
`;

export function parseIngestArgs(args: string[]): IngestOptions {
	const options: IngestOptions = {
		input: "./to-ingest/",
		output: "./evidence/",
		split: "1w",
		layout: "by-period",
		media: "none",
		mediaSince: null,
		mediaUntil: null,
		disclaimer: false,
		force: false,
		self: null,
		timezone: "America/Sao_Paulo",
		dateFormat: null,
		aliases: new Map(),
		concurrency: 3,
		regenerate: false,
		contact: null,
		dryRun: false,
		quiet: false,
		verbose: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const next = args[i + 1];

		switch (arg) {
			case "--input":
				options.input = next!;
				i++;
				break;
			case "--output":
				options.output = next!;
				i++;
				break;
			case "--split":
				if (!VALID_SPLITS.has(next!)) {
					throw new Error(
						`Valor inválido para --split: ${next}. Use: ${[...VALID_SPLITS].join(", ")}`,
					);
				}
				options.split = next as SplitInterval;
				i++;
				break;
			case "--layout":
				if (!VALID_LAYOUTS.has(next!)) {
					throw new Error(
						`Valor inválido para --layout: ${next}. Use: ${[...VALID_LAYOUTS].join(", ")}`,
					);
				}
				options.layout = next as "by-period" | "by-contact";
				i++;
				break;
			case "--media":
				if (!VALID_MEDIA.has(next!)) {
					throw new Error(
						`Valor inválido para --media: ${next}. Use: ${[...VALID_MEDIA].join(", ")}`,
					);
				}
				options.media = next as "none" | "audio" | "images" | "all";
				i++;
				break;
			case "--media-since":
			case "--media-until":
				if (!next || !ISO_DATE_RE.test(next)) {
					throw new Error(
						`Valor inválido para ${arg}: ${next}. Use: AAAA-MM-DD`,
					);
				}
				if (arg === "--media-since") options.mediaSince = next;
				else options.mediaUntil = next;
				i++;
				break;
			case "--disclaimer":
			case "-d":
				options.disclaimer = true;
				break;
			case "--force":
			case "-f":
				options.force = true;
				break;
			case "--self":
				options.self = next!;
				i++;
				break;
			case "--timezone":
				options.timezone = next!;
				i++;
				break;
			case "--date-format":
				if (!VALID_DATE_FORMATS.has(next!)) {
					throw new Error(
						`Valor inválido para --date-format: ${next}. Use: DD/MM ou MM/DD`,
					);
				}
				options.dateFormat = next as "DD/MM" | "MM/DD";
				i++;
				break;
			case "--alias": {
				const eqIdx = next!.indexOf("=");
				if (eqIdx === -1) {
					throw new Error(
						`Formato inválido para --alias: ${next}. Use: "fonte=destino"`,
					);
				}
				const source = next!.slice(0, eqIdx);
				const target = next!.slice(eqIdx + 1);
				options.aliases.set(source, target);
				i++;
				break;
			}
			case "--concurrency":
				options.concurrency = Number.parseInt(next!, 10);
				i++;
				break;
			case "--contact":
				options.contact = next!;
				i++;
				break;
			case "--regenerate":
				options.regenerate = true;
				break;
			case "--dry-run":
				options.dryRun = true;
				break;
			case "--quiet":
			case "-q":
				options.quiet = true;
				break;
			case "--verbose":
			case "-v":
				options.verbose = true;
				break;
		}
	}

	return options;
}
