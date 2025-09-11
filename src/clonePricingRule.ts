import 'dotenv/config'
import path from 'path'
import { excelToJson } from './excel.js';
import { getAllRecords, getPicklistMap, insertRecords, parseLabelsNormal, parseLabelsWithPouch, parsePrice, translatePaymentConditionByUser, translatePaymentConditionQA, translatePricebookByUser, translatePricebookQA } from './utils.js';
import { loginToOrg } from './auth.js';

const filesNamesByPricebook: Record<string, string> = {
  'Distribuidores': 'tabela_vendas_2025_V4_AGOSTO.xlsx',
  'Geral': 'tabela_vendas_2025_V4_AGOSTO.xlsx',
  'Speaker': 'tabela_vendas_2025_V4_AGOSTO.xlsx'
}

const familyWithDiscountTax = ['VISALIFT']

async function main() {
  const connDest = await loginToOrg(
    process.env.SF_DEST_USERNAME!,
    process.env.SF_DEST_PASSWORD!,
    'destino'
  )

  const translatePricebook = translatePricebookByUser[process.env.SF_DEST_USERNAME] || translatePricebookQA
  const translatePaymentCondition = translatePaymentConditionByUser[process.env.SF_DEST_USERNAME] || translatePaymentConditionQA

  const lPricebook = await getAllRecords(connDest, ['Id', 'Name'], 'Pricebook2')

  const mPricebookIdByName: Record<string, string> = {}

  for (const [key, translatedName] of Object.entries(translatePricebook)) {
    const pb = lPricebook.find(p => p.Name === translatedName)
    if (pb) {
      mPricebookIdByName[key] = pb.Id
    } else {
      console.warn(`⚠️ Pricebook não encontrado para "${translatedName}"`)
    }
  }

  const lProduct = await getAllRecords(connDest, ['Id', 'ProductCode'], 'Product2')
  const mProductIdByProductCode: Record<string, string> = {}

  for (const product of lProduct) {
    mProductIdByProductCode[product.ProductCode.replace('-', '')] = product.Id
  }

  const lPaymentCondition = await getAllRecords(connDest, ['Id', 'Name'], 'CA_CondicaoPagamento__c')
  const mPaymentConditionIdByName: Record<string, string> = {}

  for (const paymentCondition of lPaymentCondition) {
    mPaymentConditionIdByName[paymentCondition.Name] = paymentCondition.Id
  }

  const mProductFamilyValueByLabel = await getPicklistMap(connDest, 'Product2', 'Family')

  const inputDir = path.resolve('filesToRead')

  const lPricingRuleToInsert = []
  const lPricingRuleItemToInsert = []
  const mLabelsByProductFamily: Record<string, string[]> = {}
  const mRangesByProductFamily: Record<string, any[]> = {}
  const mExcelSheetsByPricebookName: Record<string, { [sheetName: string]: any[] }> = {}

  for (const pricebookName of Object.keys(filesNamesByPricebook)) {

    const lExcelSheets = await excelToJson(path.join(inputDir, filesNamesByPricebook[pricebookName]), 1)
    mExcelSheetsByPricebookName[pricebookName] = lExcelSheets

    const mListPricingRuleByProductFamily: Record<string, any[]> = {}

    for (const excelSheetName of Object.keys(lExcelSheets)) {
      const productFamily = mProductFamilyValueByLabel[excelSheetName] ?? 'BIOFILS'

      if (mListPricingRuleByProductFamily[productFamily]) {
        continue
      }

      const lRows = lExcelSheets[excelSheetName]
      const excelRow = lRows[0]

      const quantityLabels = Object.keys(excelRow).filter(key => {
        const text = key.trim().toUpperCase();
        return (
          text === "POUCH" ||
          text.startsWith("ATÉ") ||
          text.startsWith("ENTRE") ||
          /^\d+\+/.test(text) ||
          /^\d+\s*(CAIXAS?|POUCHES?)?\s*OU\s*\+$/.test(text)
        );

      });

      let labels = []
      let ranges = []

      if (quantityLabels.length) {
        labels = quantityLabels
      } else {
        labels = Object.keys(excelRow).filter(key => {
          const keyFormatted = key.replace(/\r?\n/g, ' ').trim()
          return !quantityLabels.includes(keyFormatted) && translatePaymentCondition[keyFormatted] !== undefined;
        })
      }

      const hasPouch = quantityLabels.some(l => l.trim().toUpperCase() === "POUCH");

      ranges = hasPouch ? parseLabelsWithPouch(labels) : parseLabelsNormal(labels, mPaymentConditionIdByName, translatePaymentCondition)

      mLabelsByProductFamily[productFamily] = labels
      mRangesByProductFamily[productFamily] = ranges

      for (const range of ranges) {
        const isRange = range.to || range.from
        const pricingRule = isRange ? {
          To__c: parseInt(range.to),
          From__c: parseInt(range.from),
          ProductFamily__c: productFamily,
          Pricebook__c: mPricebookIdByName[pricebookName],
          DiscountTax__c: familyWithDiscountTax.includes(productFamily)
        } : {
          ProductFamily__c: productFamily,
          PaymentCondition__c: range,
          Pricebook__c: mPricebookIdByName[pricebookName],
          DiscountTax__c: familyWithDiscountTax.includes(productFamily)
        }

        if (!mListPricingRuleByProductFamily[productFamily]) {
          mListPricingRuleByProductFamily[productFamily] = []
        }

        mListPricingRuleByProductFamily[productFamily] = mListPricingRuleByProductFamily[productFamily].concat(pricingRule)

        lPricingRuleToInsert.push(pricingRule)
      }

    }
  }

  const pricingRuleIds = await insertRecords(connDest, 'PricingRule__c', lPricingRuleToInsert)

  for (const pricebookName of Object.keys(filesNamesByPricebook)) {

    const where = `Id IN (${pricingRuleIds.map(v => `'${v.replace(/'/g, "\\'")}'`).join(',')})`;

    const pricingRules = await getAllRecords(connDest, ['Id', 'ProductFamily__c', 'To__c', 'From__c', 'PaymentCondition__c', 'Pricebook__c'], 'PricingRule__c', where)

    const mPricingRuleIdByCustomizedId: Record<string, any[]> = {}

    for (const pricingRule of pricingRules) {
      const hasPaymentConditon = pricingRule.PaymentCondition__c

      const key = pricingRule.Pricebook__c + '_' + pricingRule.ProductFamily__c + '_' + (hasPaymentConditon ? pricingRule.PaymentCondition__c : pricingRule.To__c + '_' + pricingRule.From__c)

      mPricingRuleIdByCustomizedId[key] = pricingRule.Id
    }

    const lExcelSheets = mExcelSheetsByPricebookName[pricebookName]

    for (const excelSheetName of Object.keys(lExcelSheets)) {
      const productFamily = mProductFamilyValueByLabel[excelSheetName] ?? 'BIOFILS'
      const lRows = lExcelSheets[excelSheetName]
      const labels = mLabelsByProductFamily[productFamily]
      const ranges = mRangesByProductFamily[productFamily]

      for (const row of lRows) {
        const isPouch = labels.includes('POUCH')
        const productCode = row[Object.keys(row)?.[0]];

        for (let i = 0; i < labels.length; i++) {
          const label = labels[i]
          const range = ranges[i]
          const isRange = range.to || range.from

          const key = mPricebookIdByName[pricebookName] + '_' + productFamily + '_' + (!isRange ? range : range.to + '_' + range.from)
          const price = parsePrice(row[label])

          const pricingRuleItem = {
            Price__c: isPouch ? (i == 0 ? price : price / 10) : price,
            PricingRule__c: mPricingRuleIdByCustomizedId[key],
            Product__c: mProductIdByProductCode[productCode]
          }

          lPricingRuleItemToInsert.push(pricingRuleItem)
        }
      }
    }
  }

  await insertRecords(connDest, 'PricingRuleItem__c', lPricingRuleItemToInsert)

}

main()