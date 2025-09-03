import 'dotenv/config'
import { loginToOrg } from './auth.js'
import { excelToJson, generateExcelReport } from './excel.js'
import path from 'path'
import { chunkArray, getAllRecords } from './utils.js'
import { RecordResult } from './excel.js'
import ora from 'ora'

const FILE_TO_READ_NAME = 'Controle de Estoque  Pharmaesthetics 2025 - 07 2025 - Sem Vinculo - V2.xlsx'

async function main() {
    const connDest = await loginToOrg(
        process.env.SF_DEST_USERNAME!,
        process.env.SF_DEST_PASSWORD!,
        'destino'
    );

    const lProduct = await getAllRecords(connDest, ['Id', 'ProductCode'], 'Product2');
    const mProductIdByProductCode: Record<string, string> = {};

    for (const product of lProduct) {
        mProductIdByProductCode[product.ProductCode] = product.Id;
    }

    const inputDir = path.resolve('filesToRead');

    const spinner = ora(`Atualizando os BonusPrice__c...`).start();

    const lExcelRows = Object.values(await excelToJson(path.join(inputDir, FILE_TO_READ_NAME), 6))?.[0];

    const lProductsToUpdate = [];

    for (const excelRow of lExcelRows) {

        const productCode = excelRow['Código'];
        const productId = mProductIdByProductCode[excelRow['Código']];
        const bonusPrice = Number.parseFloat(excelRow[' Unit _1']).toFixed(2);

        if (/PA|PR/.test(productCode)) {
            console.log(`${productCode} ${productId} ${bonusPrice}`)
        }

        if (!/PA|PR/.test(productCode) || !productId) {
            continue;
        }

        lProductsToUpdate.push({
            Id: productId,
            BonusPrice__c: bonusPrice,
        })
    }

    spinner.succeed(`Encontrados ${lProductsToUpdate.length} registros de Produto para atualizar`)

    let totalSuccess = 0;

    const batchSize = 200;
    let totalResult = [];

    const chunks = chunkArray(lProductsToUpdate, batchSize);

    for (const [index, chunk] of chunks.entries()) {
        const result = await connDest.sobject('Product2').update(chunk, { allOrNone: false });

        const insertResult: RecordResult[] = [];

        for (let i = 0; i < result.length; i++) {
            const res = result[i];
            insertResult.push({
                Inserido: res.success ? '✅' : '❌',
                IdSalesforce: res.id,
                Erro: res.errors?.[0]?.message
            });

            if (!res.success) {
                continue;
            }

            totalSuccess++;
        }

        totalResult.push(...insertResult);

        ora().info(`Chunk ${index + 1}/${chunks.length} finalizada: ${insertResult.filter(r => r.Inserido === '✅').length} processados com sucesso!`);
    }

    ora().succeed(`✅ Total atualizado na org destino: ${totalSuccess}`);

    await generateExcelReport('Product2', lProductsToUpdate, totalResult);
}

main()
