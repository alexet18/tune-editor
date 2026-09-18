import type {IDefinitionParameter, DataType, AxisDefinition, Definition, RationalFormula, ConditionalMath, ConditionalMathBranch} from '../types';

// --- Math equation parsing ---
// The full evaluator lives below; it handles linear / chained / rational and
// MHD+ `IF()` conditional conversions.

// Keep these in sync with tools/parse_xdf.py. Some generated XDFs use named
// array indices in their technical IDs while A2L/JSON definitions use numbers.
const ARRAY_INDEX_MAP: Record<string, string> = {
    stnd: '0', lft_1: '1',
    mt: '0', atc: '1', cvt: '2', dct: '3',
    tq_cmb_sng: '0', tq_cmb_opp_2: '1', tq_cmb_opp_2_s_1: '2',
    tq_cmb_opp_3: '3', tq_cmb_mpi: '4', tq_cmb_ch_sng: '5',
    tq_cmb_ch_mpl: '6', tq_cmb_ch_sa: '7',
    pow_0: '0', pow_1: '1', pow_2: '2', pow_3: '3', pow_4: '4',
    pow_ef_0: '0', pow_ef_1: '1', pow_ef_2: '2',
};

for (let i = 1; i <= 32; i++) {
    ARRAY_INDEX_MAP[`case_${i}`] = String(i - 1);
    ARRAY_INDEX_MAP[`case_req_opp_${i}`] = String(i - 1);
}

const PARAM_FACTOR_OVERRIDES: Record<string, number> = {
    c_prs_im_sp_max: 0.01,
    c_prs_im_sp_lim: 0.01,
    c_m_air_cyl_sp_max: 1_000_000,
};

const DSG_TERM_MAP: Array<[RegExp, string]> = [
    [/Hochschaltkennfeld/gi, 'Upshift map'],
    [/R.?ckschaltkennfeld/gi, 'Downshift map'],
    [/Schaltzeiten/gi, 'Shift times'],
    [/Stalldrehzahl/gi, 'Stall speed'],
    [/Momentenreduktion/gi, 'Torque reduction'],
    [/Hauptdruck/gi, 'Main pressure'],
    [/Kupplung/gi, 'Clutch'],
];

function normalizeArrayIndices(name: string): string {
    return name
        .replace(/^DATA_LMVLim\./i, '')
        .replace(/\[([A-Za-z][A-Za-z0-9_]*)]/g, (_match, label: string) =>
            `[${ARRAY_INDEX_MAP[label.toLowerCase()] ?? label}]`)
        .toLowerCase();
}

function isTechnicalId(line: string): boolean {
    const value = line.trim();
    return value.length > 0 && !value.includes(' ') && (value.includes('_') || value.includes('['));
}

function extractXdfIdentity(title: string, xdfDescription: string): { id: string; description: string } {
    const descriptionLines = xdfDescription
        ? xdfDescription.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
        : [];
    const technicalLine = descriptionLines.find(isTechnicalId) || '';

    if (technicalLine) {
        return {
            id: normalizeArrayIndices(technicalLine),
            description: descriptionLines.filter(line => line !== technicalLine).join('\n'),
        };
    }

    return {
        id: normalizeArrayIndices(title),
        description: xdfDescription && xdfDescription !== title ? xdfDescription : '',
    };
}

function translateDsgTerms(description: string): string {
    return DSG_TERM_MAP.reduce(
        (translated, [pattern, replacement]) => translated.replace(pattern, replacement),
        description,
    );
}

function parseInteger(value: string | null, fallback: number): number {
    if (!value) return fallback;
    const parsed = parseInt(value, /^[-+]?0x/i.test(value) ? 16 : 10);
    return Number.isNaN(parsed) ? fallback : parsed;
}

export interface ResolvedMath {
    factor: number;
    offset: number;
    formula?: RationalFormula;
    conditional?: ConditionalMath;
}

type MathToken =
    | {t: 'num'; v: number}
    | {t: 'x'}
    | {t: 'op'; v: string};

type Poly = number[];

interface Rat {
    num: Poly; // polynomial in X, ascending degree
    den: Poly;
}

const RAT_X: Rat = {num: [0, 1], den: [1]};

function trimPoly(p: Poly): Poly {
    while (p.length > 1 && Math.abs(p[p.length - 1]) < 1e-15) p.pop();
    return p;
}

function polyAdd(a: Poly, b: Poly): Poly {
    const out = new Array(Math.max(a.length, b.length)).fill(0);
    for (let i = 0; i < a.length; i++) out[i] += a[i];
    for (let i = 0; i < b.length; i++) out[i] += b[i];
    return trimPoly(out);
}

function polyMul(a: Poly, b: Poly): Poly {
    const out = new Array(a.length + b.length - 1).fill(0);
    for (let i = 0; i < a.length; i++) {
        if (a[i] === 0) continue;
        for (let j = 0; j < b.length; j++) {
            if (b[j] !== 0) out[i + j] += a[i] * b[j];
        }
    }
    return trimPoly(out);
}

function ratMul(a: Rat, b: Rat): Rat {
    return {num: polyMul(a.num, b.num), den: polyMul(a.den, b.den)};
}

function ratDiv(a: Rat, b: Rat): Rat {
    return {num: polyMul(a.num, b.den), den: polyMul(a.den, b.num)};
}

function ratAdd(a: Rat, b: Rat): Rat {
    return {num: trimPoly(polyAdd(polyMul(a.num, b.den), polyMul(b.num, a.den))), den: polyMul(a.den, b.den)};
}

function ratSub(a: Rat, b: Rat): Rat {
    return {num: trimPoly(polyAdd(polyMul(a.num, b.den), polyMul(b.num, a.den).map(c => -c))), den: polyMul(a.den, b.den)};
}

/** Fold `+-` / `-+` / `--` / `++` sign pairs left by MHD+ exports. */
function collapseSigns(e: string): string {
    let s = e;
    for (let i = 0; i < 4; i++) {
        const next = s
            .replace(/\+\s*\+\s*/g, '+')
            .replace(/-\s*-\s*/g, '+')
            .replace(/\+\s*-\s*/g, '-')
            .replace(/-\s*\+\s*/g, '-');
        if (next === s) break;
        s = next;
    }
    return s;
}

function tokenizeMath(expr: string): MathToken[] {
    const toks: MathToken[] = [];
    let i = 0;
    while (i < expr.length) {
        const ch = expr[i];
        if (/[0-9]/.test(ch)) {
            const m = expr.slice(i).match(/^[0-9]*\.?[0-9]+([eE][+-]?[0-9]+)?/);
            if (!m) throw new Error(`Bad number in equation at ${i}`);
            toks.push({t: 'num', v: parseFloat(m[0])});
            i += m[0].length;
        } else if (ch === '.') {
            const m = expr.slice(i).match(/^\.\d+([eE][+-]?\d+)?/);
            if (!m) throw new Error(`Bad decimal in equation at ${i}`);
            toks.push({t: 'num', v: parseFloat(m[0])});
            i += m[0].length;
        } else if (ch === 'x' || ch === 'X') {
            toks.push({t: 'x'});
            i++;
        } else if (/\s/.test(ch)) {
            i++;
        } else if (ch === '+' || ch === '-' || ch === '*' || ch === '/' || ch === '(' || ch === ')') {
            toks.push({t: 'op', v: ch});
            i++;
        } else {
            throw new Error(`Unexpected char ${ch} in equation`);
        }
    }
    return toks;
}

function parseMathPrimary(toks: MathToken[], pos: {i: number}): Rat {
    const tok = toks[pos.i];
    if (!tok) throw new Error('Unexpected end of equation');
    if (tok.t === 'num') {
        pos.i++;
        return {num: [tok.v], den: [1]};
    }
    if (tok.t === 'x') {
        pos.i++;
        return {num: [0, 1], den: [1]};
    }
    if (tok.t === 'op' && tok.v === '(') {
        pos.i++;
        const inner = parseMathAddSub(toks, pos);
        const close = toks[pos.i];
        if (close && close.t === 'op' && close.v === ')') pos.i++;
        return inner;
    }
    throw new Error('Unexpected token in equation');
}

function parseMathUnary(toks: MathToken[], pos: {i: number}): Rat {
    const tok = toks[pos.i];
    if (tok && tok.t === 'op' && (tok.v === '+' || tok.v === '-')) {
        pos.i++;
        const operand = parseMathUnary(toks, pos);
        return tok.v === '-' ? ratMul(operand, {num: [-1], den: [1]}) : operand;
    }
    return parseMathPrimary(toks, pos);
}

function parseMathMulDiv(toks: MathToken[], pos: {i: number}): Rat {
    let left = parseMathUnary(toks, pos);
    for (;;) {
        const tok = toks[pos.i];
        if (tok && tok.t === 'op' && (tok.v === '*' || tok.v === '/')) {
            pos.i++;
            const right = parseMathUnary(toks, pos);
            left = tok.v === '*' ? ratMul(left, right) : ratDiv(left, right);
        } else return left;
    }
}

function parseMathAddSub(toks: MathToken[], pos: {i: number}): Rat {
    let left = parseMathMulDiv(toks, pos);
    for (;;) {
        const tok = toks[pos.i];
        if (tok && tok.t === 'op' && (tok.v === '+' || tok.v === '-')) {
            pos.i++;
            const right = parseMathMulDiv(toks, pos);
            left = tok.v === '+' ? ratAdd(left, right) : ratSub(left, right);
        } else return left;
    }
}

function ratToResolved(r: Rat): ResolvedMath {
    const num = r.num;
    const den = r.den;
    // In practice numerator/denominator never exceed degree 1 here.
    const a = num.length > 1 ? num[1] : 0;
    const b = num[0] ?? 0;
    const c = den[0] ?? 1;
    const d = den.length > 1 ? den[1] : 0;
    if (Math.abs(d) < 1e-15) {
        if (Math.abs(c) < 1e-15) return {factor: 1, offset: 0};
        return {factor: a / c, offset: b / c};
    }
    // physical = (a*X + b) / (c + d*X) — non-linear, keep rational formula
    return {factor: 1, offset: 0, formula: {a, b, c, d}};
}

function splitTopLevel(s: string, sep: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let cur = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '(') depth++;
        else if (ch === ')') depth--;
        if (ch === sep && depth === 0) {
            parts.push(cur);
            cur = '';
        } else cur += ch;
    }
    parts.push(cur);
    return parts;
}

function evalNumericExpr(expr: string): ResolvedMath {
    try {
        const toks = tokenizeMath(expr);
        const pos = {i: 0};
        const rat = parseMathAddSub(toks, pos);
        return ratToResolved(rat);
    } catch {
        return {factor: 1, offset: 0};
    }
}

function tryParseConditional(expr: string, addressVars: Map<string, number>): ResolvedMath | null {
    if (!/^IF\s*\(/i.test(expr)) return null;

    let depth = 0;
    const start = expr.indexOf('(');
    let end = -1;
    for (let i = start; i < expr.length; i++) {
        if (expr[i] === '(') depth++;
        else if (expr[i] === ')') {
            depth--;
            if (depth === 0) {
                end = i;
                break;
            }
        }
    }
    if (end < 0 || end !== expr.length - 1) return null;

    const parts = splitTopLevel(expr.slice(start + 1, end), ';');
    if (parts.length !== 3) return null;

    const condMatch = parts[0].trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*==\s*(-?\d+)$/);
    if (!condMatch) return null;

    const address = addressVars.get(condMatch[1].trim());
    if (address === undefined) return null;
    const equals = parseInt(condMatch[2], 10);

    const thenRes = evalXdfMathEquation(parts[1], addressVars);
    const elseRes = evalXdfMathEquation(parts[2], addressVars);

    const thenBranch: ConditionalMathBranch = {
        equals,
        factor: thenRes.factor,
        offset: thenRes.offset,
        formula: thenRes.formula,
    };

    if (elseRes.conditional && elseRes.conditional.address === address) {
        return {
            factor: elseRes.factor,
            offset: elseRes.offset,
            formula: elseRes.formula,
            conditional: {
                address,
                branches: [thenBranch, ...elseRes.conditional.branches],
                fallback: elseRes.conditional.fallback,
            },
        };
    }

    return {
        factor: elseRes.factor,
        offset: elseRes.offset,
        formula: elseRes.formula,
        conditional: {
            address,
            branches: [thenBranch],
            fallback: {factor: elseRes.factor, offset: elseRes.offset, formula: elseRes.formula},
        },
    };
}

/**
 * Evaluate an XDF MATH equation. `addressVars` maps the ids of VAR elements
 * that carry a `type="address"` attribute onto their binary offset — used by
 * the MHD+ `IF()` conditional conversions.
 */
export function evalXdfMathEquation(equation: string, addressVars?: Map<string, number>): ResolvedMath {
    const expr = collapseSigns((equation || 'X').trim());
    if (!expr) return {factor: 1, offset: 0};
    const cond = tryParseConditional(expr, addressVars ?? new Map());
    if (cond) return cond;
    return evalNumericExpr(expr);
}

function parseMathElement(mathEl: Element | null): ResolvedMath {
    const equation = mathEl?.getAttribute('equation') || 'X';
    const addressVars = new Map<string, number>();
    if (mathEl) {
        for (const v of mathEl.querySelectorAll('VAR')) {
            if ((v.getAttribute('type') || '').toLowerCase() === 'address') {
                const addr = parseAddress(v.getAttribute('address'));
                if (addr !== null) addressVars.set((v.getAttribute('id') || '').trim(), addr);
            }
        }
    }
    return evalXdfMathEquation(equation, addressVars);
}

// --- Data type from XDF flags ---

function getDataType(sizeBits: number, typeFlags: number): DataType {
    const signed = (typeFlags & 0x01) !== 0;
    if ((typeFlags & 0x10000) && sizeBits === 32) return 'FLOAT32';
    switch (sizeBits) {
        case 8:
            return signed ? 'SBYTE' : 'UBYTE';
        case 16:
            return signed ? 'SWORD' : 'UWORD';
        case 32:
            return signed ? 'SLONG' : 'ULONG';
        default:
            return 'UWORD';
    }
}

// --- Address parsing ---

function parseAddress(addrStr: string | null): number | null {
    if (!addrStr) return null;
    return parseInt(addrStr, addrStr.startsWith('0x') || addrStr.startsWith('0X') ? 16 : 16);
}

// --- Axis parsing ---

interface ParsedAxis {
    address: number;
    dataType: DataType;
    cols: number;
    rows: number;
    unit: string;
    factor: number;
    offset: number;
    min: number;
    max: number;
    formula?: RationalFormula;
    conditional?: ConditionalMath;
    outputType?: number;
    embedded: boolean;
    points?: number;
    labels?: string[];
}

function parseAxisLabels(axisEl: Element): string[] | undefined {
    const labels: string[] = [];

    for (const labelEl of Array.from(axisEl.children)) {
        if (labelEl.tagName.toUpperCase() !== 'LABEL') continue;

        const indexStr = labelEl.getAttribute('index') || '';
        const index = parseInt(indexStr, indexStr.startsWith('0x') || indexStr.startsWith('0X') ? 16 : 10);
        if (!Number.isInteger(index) || index < 0) continue;

        labels[index] = labelEl.getAttribute('value') ?? '';
    }

    return labels.length > 0 ? labels : undefined;
}

function placeholderAxis(points: number, labels?: string[], outputType?: number): ParsedAxis {
    return {
        address: 0,
        dataType: 'UWORD',
        cols: points,
        rows: 1,
        unit: '',
        factor: 1,
        offset: 0,
        min: 0,
        max: 0,
        embedded: false,
        points,
        labels,
        outputType,
    };
}

function parseAxisElement(axisEl: Element): ParsedAxis | null {
    const embed = axisEl.querySelector('EMBEDDEDDATA') || axisEl.querySelector('embeddedData');
    const indexCountEl = axisEl.querySelector('indexcount');
    const points = parseInt(indexCountEl?.textContent || '1', 10);
    const labels = parseAxisLabels(axisEl);
    const outputType = parseInteger(axisEl.querySelector('outputtype')?.textContent ?? null, 1);

    // No embedded data or no address/typeflags → non-embedded axis
    if (!embed || (!embed.getAttribute('mmedaddress') && !embed.getAttribute('mmedtypeflags'))) {
        return placeholderAxis(points, labels, outputType);
    }

    const address = parseAddress(embed.getAttribute('mmedaddress')) ?? 0;

    // 0xFFFFFFFF (DSG) and 0x0 (MHD+) are sentinels for "no address"
    // placeholder axes — never read real data from offset zero.
    if (address === 0xFFFFFFFF || address === 0x0) {
        return placeholderAxis(points, labels, outputType);
    }

    const sizeBits = parseInt(embed.getAttribute('mmedelementsizebits') || '16', 10);
    const typeFlags = parseInt(embed.getAttribute('mmedtypeflags') || '0', 16);
    const cols = parseInt(embed.getAttribute('mmedcolcount') || '1', 10);
    const rows = parseInt(embed.getAttribute('mmedrowcount') || '1', 10);

    const {factor, offset, formula, conditional} = parseMathElement(axisEl.querySelector('MATH'));

    const unit = axisEl.querySelector('units')?.textContent || '';
    const min = parseFloat(axisEl.querySelector('min')?.textContent || '0');
    const max = parseFloat(axisEl.querySelector('max')?.textContent || '0');

    return {
        address,
        dataType: getDataType(sizeBits, typeFlags),
        cols, rows, unit, factor, offset, formula, conditional, outputType, min, max,
        embedded: true,
        points: cols > 1 ? cols : points,
        labels,
    };
}

// --- Main parser ---

export class XDFParser {
    private xmlDoc: Document | null = null;
    private baseOffset = 0;
    private bigEndian = false;
    private title = '';
    private fileName = '';
    private categoryMap: Map<number, string> = new Map();
    private skipAutogen = true;
    private preferTitleNames = false;

    constructor(options?: {skipAutogen?: boolean}) {
        if (typeof options?.skipAutogen === 'boolean') this.skipAutogen = options.skipAutogen;
    }

    /** Whether duplicate "(autogen)" axis/breakpoint tables are skipped. */
    getSkipAutogen(): boolean {
        return this.skipAutogen;
    }

    setSkipAutogen(value: boolean): void {
        this.skipAutogen = value;
    }

    /** True when the XDF carries MHD+ categories; those prefer human titles. */
    isMhdPlus(): boolean {
        return this.preferTitleNames;
    }

    parseXDFString(text: string): void {
        const parser = new DOMParser();
        this.xmlDoc = parser.parseFromString(text, 'text/xml');

        const header = this.xmlDoc.querySelector('XDFHEADER');
        if (!header) return;

        // Title (EPK/version)
        this.title = header.querySelector('deftitle')?.textContent || '';

        // BASEOFFSET
        const baseEl = header.querySelector('BASEOFFSET');
        if (baseEl) {
            const offsetStr = baseEl.getAttribute('offset') || '0';
            const parsed = parseInt(offsetStr, offsetStr.startsWith('0x') ? 16 : 10);
            if (!isNaN(parsed)) this.baseOffset = parsed;
        }

        // Endianness
        const defaults = header.querySelector('DEFAULTS');
        if (defaults) {
            this.bigEndian = defaults.getAttribute('lsbfirst') === '0';
        }

        // Categories
        this.categoryMap.clear();
        for (const cat of header.querySelectorAll('CATEGORY')) {
            const indexStr = cat.getAttribute('index') || '0';
            const index = parseInt(indexStr, indexStr.startsWith('0x') ? 16 : 10);
            const name = cat.getAttribute('name') || '';
            if (name) this.categoryMap.set(index, name);
        }

        // MHD+ XDFs carry an explicit "MHD+ Suite" category and prefer the
        // human titles over the Bosch-style identifiers in descriptions.
        this.preferTitleNames = Array.from(this.categoryMap.values())
            .some(catName => /MHD/i.test(catName));
    }

    async parseXDF(file: File): Promise<void> {
        this.fileName = file.name;
        this.parseXDFString(await file.text());
    }

    generateDefinition(name?: string): Definition {
        if (!this.xmlDoc) throw new Error('No XDF file parsed');

        const parameters: IDefinitionParameter[] = [];
        const seen = new Set<string>();
        const seenIds = new Set<string>();

        // Preserve the source order and parse constants the same way as the CLI
        // parser. XDFs can freely interleave XDFTABLE and XDFCONSTANT elements.
        const flagWords = new Map<number, {title: string; mask: number; element: Element}[]>();
        for (const element of Array.from(this.xmlDoc.documentElement.children)) {
            const tagName = element.tagName.toUpperCase();
            if (tagName === 'XDFFLAG') {
                this.collectFlag(element, flagWords);
                continue;
            }
            if (tagName === 'XDFTABLE' && this.skipAutogen) {
                const title = element.querySelector('title')?.textContent?.trim() || '';
                // MHD+ exports each embedded breakpoint axis again as a
                // standalone table titled "... X (autogen)" / "... Y (autogen)".
                if (/\(autogen\)\s*$/i.test(title)) continue;
            }
            const param = tagName === 'XDFTABLE'
                ? this.parseTable(element)
                : tagName === 'XDFCONSTANT'
                    ? this.parseConstant(element)
                    : null;
            if (!param) continue;

            const key = `${param.id || param.name}\u0000${param.address}`;
            if (seen.has(key)) continue;
            seen.add(key);

            if (param.id) {
                if (seenIds.has(param.id)) param.id = `${param.id}_0x${param.address.toString(16)}`;
                seenIds.add(param.id);
            }
            parameters.push(param);
        }

        // XDF v1.70 <XDFFLAG> bitfields (e.g. MHD+ "Inhibit Limp" masks) share
        // one 32-bit word per address; merge them into editable bitmask params.
        for (const [address, flags] of flagWords) {
            const flagParam = this.buildFlagParam(address, flags);
            if (flagParam) parameters.push(flagParam);
        }

        const def: Definition = {
            name: name || this.title || (this.fileName ? this.fileName.replace(/\.xdf$/i, '') : '') || 'XDF Definition',
            version: '1.0',
            baseAddress: this.baseOffset,
            parameters,
        };

        if (this.bigEndian) def.bigEndian = true;

        return def;
    }

    private resolveCategories(element: Element): string[] {
        const entries: [number, string][] = [];
        for (const catMem of element.querySelectorAll(':scope > CATEGORYMEM')) {
            const level = parseInt(catMem.getAttribute('index') || '0', 10);
            const catIdx = parseInt(catMem.getAttribute('category') || '0', 10);
            const catName = this.categoryMap.get(catIdx - 1);
            if (catName && catName !== 'Axis') entries.push([level, catName]);
        }
        entries.sort((a, b) => a[0] - b[0]);
        const cats = entries.map(e => e[1]);

        // Filter trailing "Misc" catch-all
        if (cats.length > 1 && cats[cats.length - 1] === 'Misc') cats.pop();

        return cats;
    }

    /**
     * Picks a stable id + display name + human description.
     * Legacy A2L-generated XDFs name the parameter by the technical id that
     * leads the description; MHD+ XDFs (which carry an "MHD+ Suite" category)
     * keep the human title as the name and only use the technical id as `id`.
     */
    private resolveIdentity(title: string, xdfDesc: string): { name: string; description: string; id: string } {
        const lines = (xdfDesc || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const technicalLine = lines.find(isTechnicalId) || '';

        if (technicalLine && !this.preferTitleNames) {
            return {name: technicalLine, description: title !== technicalLine ? title : '', id: ''};
        }
        if (technicalLine) {
            return {
                name: title,
                description: lines.filter(l => l !== technicalLine).join('\n'),
                id: normalizeArrayIndices(technicalLine),
            };
        }
        if (this.preferTitleNames) {
            return {
                name: title,
                description: xdfDesc && xdfDesc !== title ? xdfDesc : '',
                id: normalizeArrayIndices(title),
            };
        }
        return {
            name: title,
            description: xdfDesc && xdfDesc !== title ? `${title} — ${xdfDesc}` : title,
            id: '',
        };
    }

    private collectFlag(element: Element, into: Map<number, {title: string; mask: number; element: Element}[]>): void {
        const embed = element.querySelector('EMBEDDEDDATA') || element.querySelector('embeddedData');
        const address = parseAddress(embed?.getAttribute('mmedaddress') ?? null);
        if (address === null) return;
        const mask = parseInteger(element.querySelector('mask')?.textContent ?? null, 0);
        const title = element.querySelector('title')?.textContent || '';
        const list = into.get(address) ?? [];
        list.push({title, mask, element});
        into.set(address, list);
    }

    private buildFlagParam(
        address: number,
        flags: {title: string; mask: number; element: Element}[]
    ): IDefinitionParameter | null {
        const bitLabels: Record<string, string> = {};
        for (const f of flags) {
            // single-bit mask → editable bit index
            if (f.mask > 0 && (f.mask & (f.mask - 1)) === 0) {
                bitLabels[String(Math.round(Math.log2(f.mask)))] = f.title;
            }
        }
        const categories = this.resolveCategories(flags[0].element);
        return {
            id: `xdf-flag-0x${address.toString(16)}`,
            name: `Error inhibit flags (0x${address.toString(16).toUpperCase()})`,
            description: flags.map(f => f.title).join(', '),
            address,
            type: 'VALUE',
            dataType: 'ULONG',
            unit: '',
            min: 0,
            max: 0xFFFFFFFF,
            factor: 1,
            offset: 0,
            bitLabels,
            categories: categories.length > 0 ? categories : ['Uncategorized'],
        };
    }

    private parseTable(element: Element): IDefinitionParameter | null {
        // Table flags: bit 5 (0x20) = COLUMN_DIR
        const flags = parseInt(element.getAttribute('flags') || '0', 16);
        const columnDir = (flags & 0x20) !== 0;

        const title = element.querySelector('title')?.textContent || '';
        const xdfDesc = element.querySelector('description')?.textContent || '';
        const {name, description, id} = this.resolveIdentity(title, xdfDesc);

        // Parse axes
        let xAxisData: ParsedAxis | null = null;
        let yAxisData: ParsedAxis | null = null;
        let zAxisData: ParsedAxis | null = null;

        for (const axisEl of element.querySelectorAll(':scope > XDFAXIS')) {
            const id = axisEl.getAttribute('id');
            const data = parseAxisElement(axisEl);
            if (!data) continue;
            if (id === 'x') xAxisData = data;
            else if (id === 'y') yAxisData = data;
            else if (id === 'z') zAxisData = data;
        }

        if (!zAxisData || !zAxisData.embedded) return null;

        const cols = zAxisData.cols;
        const rows = zAxisData.rows;

        let type: 'VALUE' | 'CURVE' | 'MAP' = 'VALUE';
        if (cols === 1 && rows === 1) type = 'VALUE';
        else if (rows === 1) type = 'CURVE';
        else type = 'MAP';

        const categories = this.resolveCategories(element);

        const param: IDefinitionParameter = {
            ...(id ? {id} : {}),
            name,
            description,
            address: zAxisData.address,
            type,
            dataType: zAxisData.dataType,
            unit: zAxisData.unit,
            min: zAxisData.min,
            max: zAxisData.max,
            factor: zAxisData.factor,
            offset: zAxisData.offset,
            ...(zAxisData.formula ? {formula: zAxisData.formula} : {}),
            ...(zAxisData.conditional ? {conditional: zAxisData.conditional} : {}),
            categories: categories.length > 0 ? categories : ['Uncategorized'],
        };

        if (type !== 'VALUE') {
            param.cols = cols;
            if (type === 'MAP') {
                param.rows = rows;
                if (columnDir) param.columnDir = true;
            }
        }

        // X axis
        if (xAxisData && xAxisData.embedded && type !== 'VALUE') {
            const axis: AxisDefinition = {
                type: 'COM_AXIS',
                points: xAxisData.points ?? xAxisData.cols,
                min: xAxisData.min,
                max: xAxisData.max,
                unit: xAxisData.unit,
                address: xAxisData.address,
                dataType: xAxisData.dataType,
            };
            if (xAxisData.factor !== 1) axis.factor = xAxisData.factor;
            if (xAxisData.offset !== 0) axis.offset = xAxisData.offset;
            if (xAxisData.formula) axis.formula = xAxisData.formula;
            if (xAxisData.conditional) axis.conditional = xAxisData.conditional;
            if (xAxisData.labels) axis.labels = xAxisData.labels;
            param.xAxis = axis;
        } else if (xAxisData && !xAxisData.embedded && type !== 'VALUE') {
            const axis: AxisDefinition = {type: 'FIX_AXIS', points: xAxisData.points ?? cols, min: 0, max: 0, unit: ''};
            if (xAxisData.labels) axis.labels = xAxisData.labels;
            param.xAxis = axis;
        }

        // Y axis
        if (yAxisData && yAxisData.embedded && type === 'MAP') {
            const axis: AxisDefinition = {
                type: 'COM_AXIS',
                points: yAxisData.points ?? yAxisData.cols,
                min: yAxisData.min,
                max: yAxisData.max,
                unit: yAxisData.unit,
                address: yAxisData.address,
                dataType: yAxisData.dataType,
            };
            if (yAxisData.factor !== 1) axis.factor = yAxisData.factor;
            if (yAxisData.offset !== 0) axis.offset = yAxisData.offset;
            if (yAxisData.formula) axis.formula = yAxisData.formula;
            if (yAxisData.conditional) axis.conditional = yAxisData.conditional;
            if (yAxisData.labels) axis.labels = yAxisData.labels;
            param.yAxis = axis;
        } else if (yAxisData && !yAxisData.embedded && type === 'MAP') {
            const axis: AxisDefinition = {type: 'FIX_AXIS', points: yAxisData.points ?? rows, min: 0, max: 0, unit: ''};
            if (yAxisData.labels) axis.labels = yAxisData.labels;
            param.yAxis = axis;
        }

        // MHD+ scalar toggles/enums carry outputtype="4" LABELs on one axis
        // (e.g. "Map 1".."Map 4", "ON"/"OFF"). Expose them as enumLabels.
        if (type === 'VALUE') {
            const enumAxis = [xAxisData, yAxisData, zAxisData]
                .find(a => a && a.outputType === 4 && a.labels && a.labels.length >= 2);
            if (enumAxis?.labels) {
                const enumLabels: Record<string, string> = {};
                enumAxis.labels.forEach((label, i) => {
                    enumLabels[String(i)] = label;
                });
                param.enumLabels = enumLabels;
            }
        }

        return param;
    }

    private parseConstant(element: Element): IDefinitionParameter | null {
        const title = element.querySelector('title')?.textContent || '';
        const xdfDesc = element.querySelector('description')?.textContent || '';
        const {id, description: extractedDescription} = extractXdfIdentity(title, xdfDesc);
        const name = title.trim() || id;
        if (!name) return null;
        const description = translateDsgTerms(extractedDescription);

        const embed = element.querySelector('EMBEDDEDDATA') || element.querySelector('embeddedData');
        if (!embed || !embed.hasAttribute('mmedaddress')) return null;
        const address = parseAddress(embed.getAttribute('mmedaddress'));
        if (address === null) return null;

        const sizeBits = parseInteger(embed.getAttribute('mmedelementsizebits'), 16);
        const typeFlags = parseInteger(embed.getAttribute('mmedtypeflags'), 0);
        const dataType = getDataType(sizeBits, typeFlags);

        const math = parseMathElement(element.querySelector('MATH'));
        const factor = PARAM_FACTOR_OVERRIDES[id] ?? math.factor;
        const {offset, formula, conditional} = math;

        const unit = element.querySelector('units')?.textContent || '';
        const minText = element.querySelector('min')?.textContent;
        const maxText = element.querySelector('max')?.textContent;
        const min = minText ? parseFloat(minText) : 0;
        const max = maxText ? parseFloat(maxText) : dataType === 'UBYTE' ? 255 : 65535;

        const categories = this.resolveCategories(element);

        return {
            id,
            name,
            description,
            address: address,
            type: 'VALUE',
            dataType,
            unit, min, max, factor, offset,
            ...(formula ? {formula} : {}),
            ...(conditional ? {conditional} : {}),
            categories: categories.length > 0 ? categories : ['Uncategorized'],
        };
    }

    getStats(): { tables: number; constants: number; total: number } {
        if (!this.xmlDoc) return {tables: 0, constants: 0, total: 0};
        return {
            tables: this.xmlDoc.querySelectorAll('XDFTABLE').length,
            constants: this.xmlDoc.querySelectorAll('XDFCONSTANT').length,
            total: this.xmlDoc.querySelectorAll('XDFTABLE').length + this.xmlDoc.querySelectorAll('XDFCONSTANT').length,
        };
    }

    getBaseOffset(): number {
        return this.baseOffset;
    }

    getTitle(): string {
        return this.title;
    }
}
