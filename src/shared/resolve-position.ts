/**
 * Shared position resolver — resolves a symbol name to a file position.
 *
 * Used by position-based tools (hover, definition, references, rename, completions)
 * to allow the LLM to pass a symbol name instead of exact line/character.
 */

import type { DocumentSymbol, SymbolInformation } from "vscode-languageserver-protocol";
import type { LspManager } from "../lsp-manager.js";
import type { TreeSitterManager } from "../tree-sitter/parser-manager.js";
import { extractSymbols, type SymbolInfo } from "../tree-sitter/symbol-extractor.js";
import { getLanguageIdFromPath } from "./language-map.js";
import { readFile } from "node:fs/promises";

export interface ResolvedPosition {
  line: number;       // 1-indexed (tool convention)
  character: number;  // 1-indexed
  symbolName: string;
  source: "lsp" | "tree-sitter" | "text";
}

type DocumentSymbolResponse = DocumentSymbol[] | SymbolInformation[] | null;

/**
 * Resolve a symbol name to a position in a file.
 *
 * Priority:
 * 1. LSP document symbols (most accurate)
 * 2. Tree-sitter symbol extraction (fallback)
 *
 * Matching priority:
 * 1. Exact case-sensitive match
 * 2. Case-insensitive exact match
 * 3. Substring match (case-insensitive)
 * 4. Dot-qualified match (e.g. "MyClass.render" matches "render" inside "MyClass")
 */
export async function resolveSymbolPosition(
  filePath: string,
  query: string,
  manager: LspManager,
  treeSitter?: TreeSitterManager | null,
): Promise<ResolvedPosition | null> {
  // Try LSP document symbols first
  const client = await manager.getClientForFile(filePath).catch(() => null);
  if (client) {
    const uri = manager.getFileUri(filePath);
    try {
      const symbols = await client.sendRequest<DocumentSymbolResponse>(
        "textDocument/documentSymbol",
        { textDocument: { uri } }
      );
      if (symbols && symbols.length > 0) {
        const match = findInDocumentSymbols(symbols, query);
        if (match) return match;
      }
    } catch { /* fall through to tree-sitter */ }
  }

  // Try tree-sitter fallback
  if (treeSitter) {
    try {
      const absPath = manager.resolvePath(filePath);
      const content = await readFile(absPath, "utf-8");
      const languageId = getLanguageIdFromPath(filePath);
      if (languageId) {
        const tree = await treeSitter.parse(absPath, content);
        if (tree) {
          const symbols = extractSymbols(tree, languageId);
          const match = findInSymbolInfos(symbols, query);
          if (match) return match;
        }
      }
    } catch { /* fall through */ }
  }

  // Text-scan fallback: locate the query as a whole-word identifier occurrence in
  // the file. LSP documentSymbol/tree-sitter only know about *declarations* in
  // this file; a query like an interface name used as a base type, or a type
  // reference inside a method signature, is not a declaration and so is invisible
  // to both. Scanning the raw text for the identifier is the only reliable way to
  // resolve such references to a position the LSP can then hover/define/references
  // on. We prefer the first occurrence outside comments/strings when possible.
  try {
    const absPath = manager.resolvePath(filePath);
    const content = await readFile(absPath, "utf-8");
    const pos = findIdentifierOccurrence(content, query);
    if (pos) {
      return { line: pos.line, character: pos.character, symbolName: query, source: "text" };
    }
  } catch { /* fall through */ }

  return null;
}

/**
 * Get top-level symbol names from a file (for error hints).
 */
export async function getSymbolNames(
  filePath: string,
  manager: LspManager,
  treeSitter?: TreeSitterManager | null,
): Promise<string[]> {
  const client = await manager.getClientForFile(filePath).catch(() => null);
  if (client) {
    const uri = manager.getFileUri(filePath);
    try {
      const symbols = await client.sendRequest<DocumentSymbolResponse>(
        "textDocument/documentSymbol",
        { textDocument: { uri } }
      );
      if (symbols && symbols.length > 0) {
        // Recurse into hierarchical DocumentSymbols so callers see nested class/method
        // names, not just the top-level namespace. Without this recursion the hint
        // only ever shows the namespace, which is misleading. SymbolInformation (flat)
        // has no children to walk.
        if ("selectionRange" in symbols[0]) {
          const names: string[] = [];
          const walk = (syms: DocumentSymbol[]): void => {
            for (const s of syms) {
              names.push(s.name);
              if (s.children) walk(s.children);
            }
          };
          walk(symbols as DocumentSymbol[]);
          return names;
        }
        return (symbols as SymbolInformation[]).map(s => s.name);
      }
    } catch { /* fall through */ }
  }

  if (treeSitter) {
    try {
      const absPath = manager.resolvePath(filePath);
      const content = await readFile(absPath, "utf-8");
      const languageId = getLanguageIdFromPath(filePath);
      if (languageId) {
        const tree = await treeSitter.parse(absPath, content);
        if (tree) {
          const symbols = extractSymbols(tree, languageId);
          return symbols.map(s => s.name);
        }
      }
    } catch { /* fall through */ }
  }

  return [];
}

// --- LSP DocumentSymbol matching ---

function findInDocumentSymbols(
  symbols: DocumentSymbol[] | SymbolInformation[],
  query: string,
): ResolvedPosition | null {
  if (symbols.length === 0) return null;

  // Check if these are DocumentSymbol (hierarchical) or SymbolInformation (flat)
  if ("selectionRange" in symbols[0]) {
    return findInHierarchicalSymbols(symbols as DocumentSymbol[], query);
  }
  return findInFlatSymbols(symbols as SymbolInformation[], query);
}

interface SymbolCandidate {
  name: string;
  line: number;      // 1-indexed
  character: number; // 1-indexed
  parent?: string;
}

function findInHierarchicalSymbols(
  symbols: DocumentSymbol[],
  query: string,
): ResolvedPosition | null {
  const candidates = flattenDocumentSymbols(symbols);
  return matchCandidates(candidates, query, "lsp");
}

function flattenDocumentSymbols(
  symbols: DocumentSymbol[],
  parent?: string,
): SymbolCandidate[] {
  const result: SymbolCandidate[] = [];
  for (const sym of symbols) {
    result.push({
      name: sym.name,
      line: sym.selectionRange.start.line + 1,
      character: sym.selectionRange.start.character + 1,
      parent,
    });
    if (sym.children && sym.children.length > 0) {
      result.push(...flattenDocumentSymbols(sym.children, sym.name));
    }
  }
  return result;
}

function findInFlatSymbols(
  symbols: SymbolInformation[],
  query: string,
): ResolvedPosition | null {
  const candidates: SymbolCandidate[] = symbols.map(sym => ({
    name: sym.name,
    line: sym.location.range.start.line + 1,
    character: sym.location.range.start.character + 1,
    parent: sym.containerName ?? undefined,
  }));
  return matchCandidates(candidates, query, "lsp");
}

// --- Tree-sitter SymbolInfo matching ---

function findInSymbolInfos(
  symbols: SymbolInfo[],
  query: string,
): ResolvedPosition | null {
  const candidates = flattenSymbolInfos(symbols);
  return matchCandidates(candidates, query, "tree-sitter");
}

function flattenSymbolInfos(
  symbols: SymbolInfo[],
  parent?: string,
): SymbolCandidate[] {
  const result: SymbolCandidate[] = [];
  for (const sym of symbols) {
    result.push({
      name: sym.name,
      line: sym.line,
      character: 1, // tree-sitter symbols don't have column precision for the name
      parent,
    });
    if (sym.children && sym.children.length > 0) {
      result.push(...flattenSymbolInfos(sym.children, sym.name));
    }
  }
  return result;
}

// --- Shared matching logic ---

function matchCandidates(
  candidates: SymbolCandidate[],
  query: string,
  source: "lsp" | "tree-sitter",
): ResolvedPosition | null {
  // Support dot-qualified queries like "MyClass.render"
  const dotIndex = query.lastIndexOf(".");
  let parentFilter: string | undefined;
  let symbolQuery: string;

  if (dotIndex > 0) {
    parentFilter = query.slice(0, dotIndex);
    symbolQuery = query.slice(dotIndex + 1);
  } else {
    symbolQuery = query;
  }

  // If dot-qualified, try to match parent.child first
  if (parentFilter) {
    const qualified = candidates.filter(
      c => c.parent?.toLowerCase() === parentFilter!.toLowerCase()
    );
    const match = matchByPriority(qualified, symbolQuery, source);
    if (match) return match;
  }

  // Fall back to unqualified match across all candidates
  return matchByPriority(candidates, symbolQuery, source);
}

function matchByPriority(
  candidates: SymbolCandidate[],
  query: string,
  source: "lsp" | "tree-sitter",
): ResolvedPosition | null {
  const queryLower = query.toLowerCase();

  // 1. Exact case-sensitive match
  const exact = candidates.find(c => c.name === query);
  if (exact) return { line: exact.line, character: exact.character, symbolName: exact.name, source };

  // 2. Case-insensitive exact match
  const caseInsensitive = candidates.find(c => c.name.toLowerCase() === queryLower);
  if (caseInsensitive) return { line: caseInsensitive.line, character: caseInsensitive.character, symbolName: caseInsensitive.name, source };

  // 3. Prefix match (case-insensitive). Restricted to a *prefix* of the symbol
  // name rather than an arbitrary substring: an arbitrary-substring match lets
  // a type referenced inside a method signature (e.g. `ExpertCompletionResult`
  // appearing in `CompleteAsync`'s `Task<ExpertCompletionResult>` return type)
  // falsely match the enclosing method when its serialized signature happens to
  // contain the type name. Prefix matching keeps short queries useful ("Expert"
  // still matches "ExpertBase") while avoiding signature-content false matches.
  const prefix = candidates.find(c => c.name.toLowerCase().startsWith(queryLower));
  if (prefix) return { line: prefix.line, character: prefix.character, symbolName: prefix.name, source };

  return null;
}

/**
 * Find the first whole-word occurrence of `identifier` in `content` as a
 * line/character position (1-indexed), skipping lines that look like comments
 * when a non-comment occurrence exists. Used as the last-resort fallback in
 * resolveSymbolPosition to locate *referenced* symbols (not declarations),
 * which documentSymbol/tree-sitter cannot see.
 */
function findIdentifierOccurrence(
  content: string,
  identifier: string,
): { line: number; character: number } | null {
  // \b in JS regex is Unicode-aware by default for ASCII word chars, which is
  // exactly what we want for typical identifiers (letters, digits, underscore).
  // Escape the identifier in case it contains regex metacharacters.
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, "g");

  const lines = content.split("\n");
  let fallback: { line: number; character: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((match = re.exec(line)) !== null) {
      const pos = { line: i + 1, character: match.index + 1 };
      const trimmed = line.trimStart();
      // Skip obvious comment lines (// or /* or * or ' in VB-like, or #region/#pragma).
      // Keep occurrences inside code even if a // appears later on the same line.
      const isCommentLine = /^(\/\/|\/\*|\*|#)/.test(trimmed);
      if (!isCommentLine) return pos;
      if (!fallback) fallback = pos;
    }
  }
  return fallback;
}
