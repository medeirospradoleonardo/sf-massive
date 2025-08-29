import { Connection } from "jsforce"

export type SObjectRecord = Record<string, any>

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