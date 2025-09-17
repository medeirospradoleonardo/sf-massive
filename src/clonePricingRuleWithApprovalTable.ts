import 'dotenv/config'
import path from 'path'
import { excelToJson } from './excel.js';
import { getAllRecords, getMapPaymentConditionIdByName, getMapPricebookIdByName, getMapProductByName, insertRecords, SObjectRecord, translateApprovalLevel, translatePaymentConditionByUser, translatePaymentConditionQA, translatePricebookByUser, translatePricebookQA } from './utils.js';
import { loginToOrg } from './auth.js';

const FILE_TO_READ_NAME = 'Parâmetros de aprovação - Pharmaesthetics v29.xlsx';

const pricebookByLevel = {
    'Geral': 'Consultor',
    'Speaker': 'Consultor',
    'Distribuidores': 'Gerente nacional'
};

const familyWithDiscountTax = ['VISALIFT'];

const INTERVAL_INIT = 0;
const INTERVAL_END = 99999999;

async function main() {
    const connDest = await loginToOrg(
        process.env.SF_DEST_USERNAME!,
        process.env.SF_DEST_PASSWORD!,
        'destino'
    );

    const mPricebookIdByName = await getMapPricebookIdByName(connDest);
    const mProductByProductCode = await getMapProductByName(connDest);
    const mPaymentConditionIdByName = await getMapPaymentConditionIdByName(connDest);

    const inputDir = path.resolve('filesToRead');

    const lPricingRuleToInsert = [];
    const lPricingRuleItemToInsert = [];
    const mLabelsByCustomizedId: Record<string, SObjectRecord> = {};

    const lExcelRows = Object.values(await excelToJson(path.join(inputDir, FILE_TO_READ_NAME), 2))?.[0];

    for (const excelRow of lExcelRows) {
        const pricebookName = excelRow['Catálogo de preços'];
        const approvalLevel = translateApprovalLevel[excelRow['Alçada de aprovação']];

        const pricebookId = mPricebookIdByName[pricebookName];
        const productCode = excelRow['Código do produto'];

        const product = mProductByProductCode[productCode];
        const family = product?.Family;

        if (!product) {
            console.warn(`⚠️ Produto não encontrado (${productCode})`);
            continue;
        }

        if (!family) {
            console.warn(`⚠️ Familia não encontrada (${productCode})`);
        }

        const quantityMin = excelRow['Quantidade mínima'];
        const quantityMax = excelRow['Quantidade máxima'];
        const paymentCondition = excelRow['Condição de Pagamento'];
        const paymentConditionId = mPaymentConditionIdByName[paymentCondition] ?? null;
        const isRange = quantityMin || quantityMax && !paymentCondition;
        const from = isRange ? parseInt(quantityMin) <= INTERVAL_INIT ? null : parseInt(quantityMin) : null;
        const to = isRange ? parseInt(quantityMax) >= INTERVAL_END ? null : parseInt(quantityMax) : null;

        // key pricebook_family_to_from_paymentCondition
        const key = pricebookId + '_' + family + '_' + to + '_' + from + '_' + paymentConditionId;

        if (pricebookByLevel[pricebookName] != approvalLevel || mLabelsByCustomizedId[key]) {
            continue;
        }

        const pricingRule = {
            Pricebook__c: pricebookId,
            ProductFamily__c: family,
            DiscountTax__c: familyWithDiscountTax.includes(family),
            To__c: to,
            From__c: from,
            PaymentCondition__c: paymentConditionId,
        };

        mLabelsByCustomizedId[key] = pricingRule;
        lPricingRuleToInsert.push(pricingRule);
    }

    const pricingRuleIds = await insertRecords(connDest, 'PricingRule__c', lPricingRuleToInsert);

    const where = `Id IN (${pricingRuleIds.map(v => `'${v.replace(/'/g, "\\'")}'`).join(',')})`;

    const pricingRules = await getAllRecords(connDest, ['Id', 'Pricebook__c', 'ProductFamily__c', 'To__c', 'From__c', 'PaymentCondition__c'], 'PricingRule__c', where);

    const mPricingRuleIdByCustomizedId: Record<string, any[]> = {};


    for (const pricingRule of pricingRules) {
        const key = pricingRule.Pricebook__c + '_' + pricingRule.ProductFamily__c + '_' + pricingRule.To__c + '_' + pricingRule.From__c + '_' + pricingRule.PaymentCondition__c;

        mPricingRuleIdByCustomizedId[key] = pricingRule.Id
    }

    for (const excelRow of lExcelRows) {
        const pricebookName = excelRow['Catálogo de preços'];
        const approvalLevel = translateApprovalLevel[excelRow['Alçada de aprovação']];

        if (pricebookByLevel[pricebookName] != approvalLevel) {
            continue;
        }

        const pricebookId = mPricebookIdByName[pricebookName];
        const productCode = excelRow['Código do produto'];
        const productId = mProductByProductCode[productCode]?.Id;
        const family = mProductByProductCode[productCode]?.Family;
        const quantityMin = excelRow['Quantidade mínima'];
        const quantityMax = excelRow['Quantidade máxima'];
        const paymentCondition = excelRow['Condição de Pagamento'];
        const paymentConditionId = mPaymentConditionIdByName[paymentCondition] ?? null;
        const priceMin = excelRow['Preço de venda mínimo'];
        const isRange = quantityMin || quantityMax && !paymentCondition;
        const from = isRange ? parseInt(quantityMin) <= INTERVAL_INIT ? null : parseInt(quantityMin) : null;
        const to = isRange ? parseInt(quantityMax) >= INTERVAL_END ? null : parseInt(quantityMax) : null;

        // key pricebook_family_to_from_paymentCondition
        const key = pricebookId + '_' + family + '_' + to + '_' + from + '_' + paymentConditionId;

        const pricingRuleId = mPricingRuleIdByCustomizedId[key];

        const pricingRuleItem = {
            PricingRule__c: pricingRuleId,
            Price__c: priceMin,
            Product__c: productId
        };

        lPricingRuleItemToInsert.push(pricingRuleItem);
    }

    await insertRecords(connDest, 'PricingRuleItem__c', lPricingRuleItemToInsert)

}

main()