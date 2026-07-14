export const MATERIAL_PARSER_VERSION = 'material-parser/1.0.0' as const;

export type MaterialSourceType = 'docx' | 'image' | 'pdf' | 'txt' | 'url';
export type ParserErrorCode = 'LOCATOR_MISSING' | 'PARSE_EMPTY' | 'UNSUPPORTED_MIME';

export interface ParseMaterialInput {
  readonly body: Uint8Array;
  readonly contentHash: string;
  readonly language: string;
  readonly mimeType: string;
  readonly sourceType: MaterialSourceType;
  readonly title: string;
  readonly url?: string;
}

export interface MaterialLocator {
  /** UTF-16 end index; document.text.slice(char_start, char_end) is the exact unit text. */
  readonly char_end: number;
  /** UTF-16 start index used by JavaScript/JSON/PostgreSQL application code. */
  readonly char_start: number;
  readonly headings: readonly string[];
  readonly page: number | null;
  readonly url: string | null;
}

export interface ParsedMaterialUnit {
  readonly locator: MaterialLocator;
  readonly text: string;
  readonly text_hash: string;
}

export interface ParsedMaterialDocument {
  readonly content_hash: string;
  readonly language: string;
  readonly metadata: {
    readonly page_count: number | null;
    readonly source_type: Exclude<MaterialSourceType, 'image'>;
  };
  readonly parser_version: typeof MATERIAL_PARSER_VERSION;
  readonly text: string;
  readonly title: string;
  readonly units: readonly ParsedMaterialUnit[];
  readonly warnings: readonly ParserWarning[];
}

export interface ParserWarning {
  readonly code: 'DOCX_CONVERSION_WARNING' | 'EMPTY_PAGE' | 'HTML_NO_MAIN_CONTENT';
  readonly message: string;
  readonly page: number | null;
}
