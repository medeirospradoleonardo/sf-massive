import 'dotenv/config'
import path from 'path'
import { excelToJson } from './excel.js';
import { getAllRecords, getPicklistMap, insertRecords, parseLabelsNormal, parseLabelsWithPouch, parsePrice } from './utils.js';
import { loginToOrg } from './auth.js';

const FILE_TO_READ_NAME = 'tabela_vendas_2025_V4_AGOSTO.xlsx'
const PRICEBOOK_NAME = 'Geral' as 'Distribuidores' | 'Geral' | 'Speaker'

const translatePaymentCondition: Record<string, string> = {
  'À VISTA': 'À Vista',
  '30% DE ENTRADA + 6X SEM JUROS': '30% Entrada +6x Sem Juros',
  '25% DE ENTRADA + 10X SEM JUROS': '25% Entrada +10x Sem Juros',
}

const translatePricebook: Record<string, string> = {
  'Distribuidores': 'Catálogo distribuidores',
  'Geral': 'Catálogo geral',
  'Speaker': 'Catálogo speakers oficial'
}

async function main() {
  const connDest = await loginToOrg(
    process.env.SF_DEST_USERNAME!,
    process.env.SF_DEST_PASSWORD!,
    'destino'
  )

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
    mProductIdByProductCode[product.ProductCode] = product.Id
  }

  const lPaymentCondition = await getAllRecords(connDest, ['Id', 'Name'], 'CA_CondicaoPagamento__c')
  const mPaymentConditionIdByName: Record<string, string> = {}

  for (const paymentCondition of lPaymentCondition) {
    mPaymentConditionIdByName[paymentCondition.Name] = paymentCondition.Id
  }

  const mProductFamilyValueByLabel = await getPicklistMap(connDest, 'Product2', 'Family')

  const outputDir = path.resolve('filesToRead')

  const filePath = path.join(outputDir, FILE_TO_READ_NAME);

  const lExcelSheets = await excelToJson(filePath, 1)

  const mLabelsByProductFamily: Record<string, string[]> = {}
  const mRangesByProductFamily: Record<string, any[]> = {}

  const mListPricingRuleByProductFamily: Record<string, any[]> = {}

  const lPricingRuleToInsert = []

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
        ProductFamily__c: productFamily
      } : {
        ProductFamily__c: productFamily,
        PaymentCondition__c: range
      }

      if (!mListPricingRuleByProductFamily[productFamily]) {
        mListPricingRuleByProductFamily[productFamily] = []
      }

      mListPricingRuleByProductFamily[productFamily] = mListPricingRuleByProductFamily[productFamily].concat(pricingRule)

      lPricingRuleToInsert.push(pricingRule)
    }

  }

  const pricingRuleIds = await insertRecords(connDest, 'PricingRule__c', lPricingRuleToInsert)

  const where = `Id IN (${pricingRuleIds.map(v => `'${v.replace(/'/g, "\\'")}'`).join(',')})`;

  const pricingRules = await getAllRecords(connDest, ['Id', 'ProductFamily__c', 'To__c', 'From__c', 'PaymentCondition__c'], 'PricingRule__c', where)

  const mPricingRuleIdByCustomizedId: Record<string, any[]> = {}

  for (const pricingRule of pricingRules) {
    const hasPaymentConditon = pricingRule.PaymentCondition__c

    const key = pricingRule.ProductFamily__c + '_' + (hasPaymentConditon ? pricingRule.PaymentCondition__c : pricingRule.To__c + '_' + pricingRule.From__c)

    mPricingRuleIdByCustomizedId[key] = pricingRule.Id
  }

  const lPricingRuleItemToInsert = []

  for (const excelSheetName of Object.keys(lExcelSheets)) {
    const productFamily = mProductFamilyValueByLabel[excelSheetName] ?? 'BIOFILS'
    const lRows = lExcelSheets[excelSheetName]
    const labels = mLabelsByProductFamily[productFamily]
    const ranges = mRangesByProductFamily[productFamily]

    for (const row of lRows) {
      const isPouch = labels.includes('POUCH')
      for (let i = 0; i < labels.length; i++) {
        const label = labels[i]
        const range = ranges[i]
        const isRange = range.to || range.from

        const key = productFamily + '_' + (!isRange ? range : range.to + '_' + range.from)
        const price = parsePrice(row[label])

        const pricingRuleItem = {
          Price__c: isPouch ? (i == 0 ? price : price / 10) : price,
          PricingRule__c: mPricingRuleIdByCustomizedId[key],
          Product__c: mProductIdByProductCode[row[Object.keys(row)?.[0]]]
        }

        lPricingRuleItemToInsert.push(pricingRuleItem)
      }
    }

  }

  await insertRecords(connDest, 'PricingRuleItem__c', lPricingRuleItemToInsert)

}

main()