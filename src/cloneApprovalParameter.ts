import 'dotenv/config'
import { loginToOrg } from './auth.js'
import { excelToJson, generateExcelReport } from './excel.js'
import path from 'path'
import { chunkArray, getAllRecords, getPicklistMap, parsePercent } from './utils.js'
import { RecordResult } from './excel.js'
import ora from 'ora'

const FILE_TO_READ_NAME = 'Parâmetros de aprovação - Pharmaesthetics v23.xlsx'
const SOBJECT_NAME = 'CA_ParametroAprovacao__c'

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
    mProductIdByProductCode[product.ProductCode.replace('-', '')] = product.Id
  }
  const mApprovalAuthorityValueByLabel = await getPicklistMap(connDest, SOBJECT_NAME, 'CA_AlcadaAprovacao__c')

  const inputDir = path.resolve('filesToRead')

  const spinner = ora(`Clonando registros de ${SOBJECT_NAME}...`).start()

  const lExcelRows = Object.values(await excelToJson(path.join(inputDir, FILE_TO_READ_NAME), 2))?.[0]

  const lApprovalParameterToInsert = []

  for (const excelRow of lExcelRows) {
    lApprovalParameterToInsert.push({
      CA_CatalagoPrecos__c: mPricebookIdByName[excelRow['Catálogo de preços']],
      CA_Produto__c: mProductIdByProductCode[excelRow['Código do produto']],
      CA_PrecoVendaMinimo__c: excelRow['Preço de venda mínimo'],
      CA_PrecVendaMaximo__c: excelRow['Preço de venda máximo'],
      CA_QuantidadeMinima__c: excelRow['Quantidade mínima'],
      CA_QuantidadeMaxima__c: excelRow['Quantidade máxima'],
      CA_PorcentagemInicialDesconto__c: parsePercent(excelRow['Porcentagem de desconto mínima']),
      CA_PorcentagemFinalDesconto__c: parsePercent(excelRow['Porcentagem de desconto máxima']),
      CA_AlcadaAprovacao__c: mApprovalAuthorityValueByLabel[excelRow['Alçada de aprovação']],
    })
  }

  spinner.succeed(`Encontrados ${lApprovalParameterToInsert.length} registros de ${SOBJECT_NAME} para inserir`)

  let totalSuccess = 0

  const batchSize = 200
  let totalResult = []

  const chunks = chunkArray(lApprovalParameterToInsert, batchSize)

  for (const [index, chunk] of chunks.entries()) {
    const result = await connDest.sobject(SOBJECT_NAME).create(chunk, { allOrNone: false })

    const insertResult: RecordResult[] = []

    for (let i = 0; i < result.length; i++) {
      const res = result[i]
      insertResult.push({
        Inserido: res.success ? '✅' : '❌',
        IdSalesforce: res.id,
        Erro: res.errors?.[0]?.message
      })

      if (!res.success) {
        continue;
      }

      totalSuccess++
    }

    totalResult.push(...insertResult)

    ora().info(`Chunk ${index + 1}/${chunks.length} finalizada: ${insertResult.filter(r => r.Inserido === '✅').length} processados com sucesso!`)
  }

  ora().succeed(`✅ Total inserido na org destino: ${totalSuccess}`)

  await generateExcelReport(SOBJECT_NAME, lApprovalParameterToInsert, totalResult)
}

main()
