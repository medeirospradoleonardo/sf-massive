import { Connection } from "jsforce"
import ora from "ora"
import { generateExcelReport, RecordResult } from "./excel.js"

export type SObjectRecord = Record<string, any>

export const translatePricebookQA: Record<string, string> = {
    'Distribuidores': 'Catálogo distribuidores',
    'Geral': 'Catálogo geral',
    'Speaker': 'Catálogo Speakers oficial'
}

export const translatePricebookDEV: Record<string, string> = {
    'Distribuidores': 'Catálogo distribuidores',
    'Geral': 'Catálogo geral',
    'Speaker': 'Catálogo speakers oficial'
}

export const translatePricebookByUser: Record<string, Record<string, string>> = {
    'leonardo@visumdigital.com.pharmaestheticsdev': translatePricebookDEV,
    'leonardo@visumdigital.pharmaesthetics.qa': translatePricebookQA,
}

export const translatePaymentConditionQA: Record<string, string> = {
    'À VISTA': 'À vista',
    '30% DE ENTRADA + 6X SEM JUROS': '30% Entrada +6x Sem Juros',
    '25% DE ENTRADA + 10X SEM JUROS': '25% Entrada +10x Sem Juros',
    'A Vista': 'À vista',
    'Entrada +6x': '30% Entrada +6x Sem Juros',
    'Entrada +10x': '25% Entrada +10x Sem Juros',
}

export const translatePaymentConditionDEV: Record<string, string> = {
    'À VISTA': 'À Vista',
    '30% DE ENTRADA + 6X SEM JUROS': '30% Entrada +6x Sem Juros',
    '25% DE ENTRADA + 10X SEM JUROS': '25% Entrada +10x Sem Juros',
    'A Vista': 'À Vista',
    'Entrada +6x': '30% Entrada +6x Sem Juros',
    'Entrada +10x': '25% Entrada +10x Sem Juros',
}

export const translatePaymentConditionByUser: Record<string, Record<string, string>> = {
    'leonardo@visumdigital.com.pharmaestheticsdev': translatePaymentConditionDEV,
    'leonardo@visumdigital.pharmaesthetics.qa': translatePaymentConditionQA,
}

export function chunkArray<T>(array: T[], size: number): T[][] {
    return Array.from({ length: Math.ceil(array.length / size) }, (_, i) =>
        array.slice(i * size, i * size + size)
    )
}

export async function getAllRecords(
    conn: Connection,
    fields: string[],
    objectName: string,
    where?: string
): Promise<SObjectRecord[]> {
    const soql = `SELECT ${fields.join(',')} FROM ${objectName} ${where ? `WHERE ${where}` : ''}`
    let result = await conn.query<SObjectRecord>(soql)
    let records = result.records

    while (!result.done) {
        result = await conn.queryMore<SObjectRecord>(result.nextRecordsUrl!)
        records = records.concat(result.records)
    }

    return records
}

export async function getPicklistMap(conn: Connection, objectApiName: string, fieldApiName: string): Promise<Record<string, string>> {
    const meta = await conn.sobject(objectApiName).describe();

    const field = meta.fields.find(f => f.name === fieldApiName);
    if (!field) throw new Error(`Campo ${fieldApiName} não encontrado no objeto ${objectApiName}`);

    // Monta um map de Label → Value
    const picklistMap: Record<string, string> = {};
    for (const value of field.picklistValues) {
        picklistMap[value.label] = value.value;
    }

    return picklistMap;
}

export function parsePercent(value: string | number | null | undefined): number | null {
    if (value == null) return null;
    if (typeof value === 'number') return value * 100; // se já veio como 5.01 → 0.0501

    const cleaned = value.toString().replace('%', '').replace(',', '.').trim();
    const num = parseFloat(cleaned);
    if (isNaN(num)) return null;

    return num / 100;
}

export function parsePrice(input: string | number): number {
    if (typeof input === 'number') return input;

    // Se for string, limpa quebras de linha e espaços
    const str = input.replace(/\r?\n/g, ' ').trim();

    // Procura "Por: <valor>"
    const matchPor = str.match(/Por:\s*([\d.,]+)/i);
    const valueStr = matchPor ? matchPor[1] : str;

    // Remove pontos de milhares e troca vírgula por ponto
    const normalized = valueStr.replace(/\./g, '').replace(',', '.');

    const price = parseFloat(normalized);

    return isNaN(price) ? 0 : price;
}

export function parseLabelsNormal(labels: string[], mPaymentConditionIdByName = {}, translatePaymentCondition = {}) {
    const ranges = [];
    const otherIds = [];
    let previousTo = null;

    const cleanLabels = labels.map(l => l.replace(/\r?\n/g, ' ').trim());

    for (const label of cleanLabels) {
        const text = label.toUpperCase();
        let from = previousTo !== null ? previousTo + 1 : null;
        let to = null;

        // --- Faixas ---
        if (text.startsWith("ATÉ")) {
            to = parseInt(text.match(/\d+/)[0], 10);
        }
        else if (/^ENTRE\s+(\d+)[^\d]+(\d+)/.test(text)) {
            const [start, end] = text.match(/\d+/g).map(Number);
            from = previousTo !== null ? previousTo + 1 : start;
            to = end;
        }
        else if (/^\d+\+/.test(text)) {
            from = previousTo !== null ? previousTo + 1 : parseInt(text.match(/\d+/)[0], 10);
            to = null;
        }
        // --- IDs ---
        else if (mPaymentConditionIdByName[translatePaymentCondition[label]] !== undefined) {
            otherIds.push(mPaymentConditionIdByName[translatePaymentCondition[label]]);
            continue;
        } else {
            continue; // ignora se não é faixa nem ID
        }

        ranges.push({ from, to });
        if (to !== null) previousTo = to;
    }

    return ranges.length > 0 ? ranges : otherIds;
}

export function parseLabelsWithPouch(labels: string[]) {
    const ranges = [];
    let previousTo = null;

    const cleanLabels = labels.map(l => l.replace(/\r?\n/g, ' ').trim());

    for (const label of cleanLabels) {
        const text = label.toUpperCase();
        let from = previousTo !== null ? previousTo + 1 : null;
        let to = null;

        if (text === "POUCH") {
            from = null;
            to = 9;
        }
        else if (text.startsWith("ATÉ")) {
            to = previousTo !== null ? previousTo + 10 : 10; // primeira faixa após POUCH
        }
        else if (text.startsWith("ENTRE")) {
            // next faixa sequencial: define to baseado na ordem
            // ex: ENTRE 2 E 4 CAIXAS → proximo bloco de 30 unidades
            to = previousTo !== null ? previousTo + 30 : 30;
        }
        else if (/^\d+\s*(CAIXAS?|POUCHES?)?\s*OU\s*\+$/.test(text) || /^\d+\+/.test(text)) {
            from = previousTo !== null ? previousTo + 1 : parseInt(text.match(/\d+/)[0], 10);
            to = null;
        } else {
            continue;
        }

        ranges.push({ from, to });
        if (to !== null) previousTo = to;
    }

    return ranges;
}

export async function insertRecords(connDest: Connection, pSObjectName: string, plRecords: SObjectRecord[]): Promise<string[]> {
    const spinner = ora(`Clonando registros de ${pSObjectName}...`).start()
    spinner.succeed(`Encontrados ${plRecords.length} registros de ${pSObjectName} para inserir`)

    let totalSuccess = 0

    const batchSize = 200
    let totalResult = []

    const chunks = chunkArray(plRecords, batchSize)
    const recordIds = []

    for (const [index, chunk] of chunks.entries()) {
        const result = await connDest.sobject(pSObjectName).create(chunk, { allOrNone: false })

        const insertResult: RecordResult[] = []

        for (let i = 0; i < result.length; i++) {
            const res = result[i]
            insertResult.push({
                Inserido: res.success ? '✅' : '❌',
                IdSalesforce: res.id,
                Erro: res.errors?.[0]?.message
            })

            recordIds.push(res.id)

            if (!res.success) {
                continue;
            }

            totalSuccess++
        }

        totalResult.push(...insertResult)

        ora().info(`Chunk ${index + 1}/${chunks.length} finalizada: ${insertResult.filter(r => r.Inserido === '✅').length} processados com sucesso!`)
    }

    ora().succeed(`✅ Total inserido na org destino: ${totalSuccess}`)

    await generateExcelReport(pSObjectName, plRecords, totalResult)

    return recordIds
}