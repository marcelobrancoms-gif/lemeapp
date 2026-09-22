require('dotenv').config();
const express = require('express');
const cors = require('cors');
const sql = require('mssql');

const app = express();
const port = 3001;

app.use(cors());
app.use(express.json());

// ==================================================
// CONFIGURAÇÃO DA BASE DE DADOS (SEM useColumnNames)
// ==================================================
const dbConfig = {
    user: process.env.DB_USER || 'comlub',
    password: process.env.DB_PASSWORD || 'jo2Qk50*',
    server: '172.19.109.4',
    port: 1433,
    database: process.env.DB_NAME || 'TOTVS_COMLUB_PROD12',
    connectionTimeout: 60000,
    requestTimeout: 180000,
    pool: { max: 50, min: 2, idleTimeoutMillis: 30000 },
    options: {
        encrypt: false,
        trustServerCertificate: true,
        enableArithAbort: true
    }
};

const globalPool = new sql.ConnectionPool(dbConfig);
const poolConnect = globalPool.connect()
    .then(pool => {
        console.log('? Conexão ao SQL Server (172.19.109.4) estabelecida com sucesso!');
        return pool;
    })
    .catch(err => {
        console.error('Falha crítica ao iniciar Pool:', err);
    });
// ==========================================
// ROTA 1: MOTOR DE CRÉDITO E DECISÃO V9
// ==========================================
app.get('/api/motor-credito', async (req, res) => {
    try {
        await poolConnect;
        let result = await globalPool.request().query(`
            SELECT TOP 30000 
                RTRIM(LTRIM(SA1.A1_COD)) AS CODIGO, RTRIM(LTRIM(SA1.A1_NOME)) AS NOME, RTRIM(LTRIM(SA1.A1_CGC)) AS CNPJ,
                RTRIM(LTRIM(SA1.A1_MUN)) AS CIDADE, RTRIM(LTRIM(SA1.A1_EST)) AS ESTADO, RTRIM(LTRIM(SA1.A1_CEP)) AS CEP,
                RTRIM(LTRIM(SA1.A1_BAIRRO)) AS BAIRRO, RTRIM(LTRIM(SA1.A1_END)) AS ENDERECO, RTRIM(LTRIM(SA1.A1_RISCO)) AS RISCO,
                CAST(SA1.A1_LC AS FLOAT) AS LIMITE, RTRIM(LTRIM(SA3.A3_NOME)) AS VENDEDOR, RTRIM(LTRIM(SA1.A1_PRICOM)) AS PRIMEIRA_COMPRA,
                RTRIM(LTRIM(SA1.A1_ULTCOM)) AS ULTIMA_COMPRA, CAST(SA1.A1_MCOMPRA AS FLOAT) AS MAIOR_COMPRA,
                CAST(SA1.A1_NROCOM AS INT) AS QTD_NOTAS, CAST(SA1.A1_SALDUP AS FLOAT) AS SALDO_ABERTO, CAST(SA1.A1_ATR AS FLOAT) AS MEDIA_DIAS_ATRASO
            FROM SA1010 SA1 WITH (NOLOCK)
            LEFT JOIN SA3010 SA3 WITH (NOLOCK) ON SA3.A3_COD = SA1.A1_VEND AND SA3.D_E_L_E_T_ = ''
            WHERE SA1.D_E_L_E_T_ = '' ORDER BY SA1.A1_ULTCOM DESC
        `);
        res.json({ success: true, data: result.recordset });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ==========================================
// ROTA 2: MOTOR LOGÍSTICO E MESA DE CARGA
// ==========================================
const motorLogisticoHandler = async (req, res) => {
    try {
        const filialParam = (req.params.filial || 'consolidado').replace(/[^a-zA-Z0-9]/g, '');
        await poolConnect;
        let result = await globalPool.request().input('filial', sql.VarChar, filialParam).query(`
            SELECT 
                RTRIM(LTRIM(SC5.C5_FILIAL)) AS Filial, RTRIM(LTRIM(SC5.C5_NUM)) AS NumeroPedido, SC5.C5_EMISSAO AS DataEmissao,
                RTRIM(LTRIM(SC5.C5_CLIENTE)) AS CodCliente, RTRIM(LTRIM(SA1.A1_CGC)) AS CnpjCliente, RTRIM(LTRIM(SA1.A1_NOME)) AS NomeCliente,
                RTRIM(LTRIM(SA1.A1_MUN)) AS Municipio, RTRIM(LTRIM(SA1.A1_EST)) AS UF, RTRIM(LTRIM(SA1.A1_CEP)) AS CEP,
                RTRIM(LTRIM(SA3.A3_NOME)) AS Vendedor, COALESCE(ROTA_OMS.Roteiro, NULLIF(RTRIM(LTRIM(SA1.A1_MUN)), ''), 'SEM ROTA') AS Rota,
                COALESCE(ROTA_OMS.Percurso, NULLIF(RTRIM(LTRIM(SA1.A1_BAIRRO)), ''), 'SEM ZONA') AS Percurso,
                RTRIM(LTRIM(SC5.C5_CONDPAG)) AS CondPagtoCod, RTRIM(LTRIM(SE4.E4_DESCRI)) AS CondPagtoDesc,
                CASE 
                    WHEN SC9_STATUS.HasCred = 1 AND SC9_STATUS.HasEst = 1 THEN 'Bloqueio Duplo' WHEN SC9_STATUS.HasCred = 1 THEN 'Bloq. Crédito'
                    WHEN SC9_STATUS.HasEst = 1 THEN 'Bloq. Estoque' WHEN SC9_STATUS.HasSC9 > 0 THEN 'Liberado'
                    WHEN MAX(SC6.C6_BLQ) = 'S' THEN 'Bloq. Crédito' ELSE 'Pendente Liberação'
                END AS StatusCarga,
                SUM((SC6.C6_QTDVEN - SC6.C6_QTDENT) * SC6.C6_PRCVEN) AS ValorPendente, SUM((SC6.C6_QTDVEN - SC6.C6_QTDENT) * SB1.B1_PESO) AS PesoPendente,
                SUM(SC6.C6_QTDVEN - SC6.C6_QTDENT) AS QtdItensPendentes
            FROM SC5010 SC5 WITH (NOLOCK)
            OUTER APPLY (
                SELECT MAX(CASE WHEN S9.C9_BLCRED <> '' AND S9.C9_BLCRED <> '  ' THEN 1 ELSE 0 END) AS HasCred, MAX(CASE WHEN S9.C9_BLEST <> ''  AND S9.C9_BLEST <> '  '  THEN 1 ELSE 0 END) AS HasEst, COUNT(S9.C9_PEDIDO) AS HasSC9
                FROM SC9010 S9 WITH (NOLOCK) WHERE RTRIM(LTRIM(S9.C9_FILIAL)) = RTRIM(LTRIM(SC5.C5_FILIAL)) AND RTRIM(LTRIM(S9.C9_PEDIDO)) = RTRIM(LTRIM(SC5.C5_NUM)) AND S9.D_E_L_E_T_ = ''
            ) SC9_STATUS
            INNER JOIN SC6010 SC6 WITH (NOLOCK) ON RTRIM(LTRIM(SC6.C6_FILIAL)) = RTRIM(LTRIM(SC5.C5_FILIAL)) AND RTRIM(LTRIM(SC6.C6_NUM)) = RTRIM(LTRIM(SC5.C5_NUM)) AND SC6.D_E_L_E_T_ = ''
            INNER JOIN SA1010 SA1 WITH (NOLOCK) ON RTRIM(LTRIM(SA1.A1_COD)) = RTRIM(LTRIM(SC5.C5_CLIENTE)) AND RTRIM(LTRIM(SA1.A1_LOJA)) = RTRIM(LTRIM(SC5.C5_LOJACLI)) AND SA1.D_E_L_E_T_ = ''
            OUTER APPLY (
                SELECT TOP 1 RTRIM(LTRIM(DA9.DA9_ROTEIR)) AS Roteiro, RTRIM(LTRIM(DA7.DA7_PERCUR)) AS Percurso
                FROM DA7010 DA7 WITH (NOLOCK) INNER JOIN DA9010 DA9 WITH (NOLOCK) ON RTRIM(LTRIM(DA9.DA9_PERCUR)) = RTRIM(LTRIM(DA7.DA7_PERCUR)) AND DA9.D_E_L_E_T_ = ''
                WHERE REPLACE(RTRIM(LTRIM(SA1.A1_CEP)), '-', '') BETWEEN REPLACE(RTRIM(LTRIM(DA7.DA7_CEPDE)), '-', '') AND REPLACE(RTRIM(LTRIM(DA7.DA7_CEPATE)), '-', '') AND DA7.D_E_L_E_T_ = ''
            ) ROTA_OMS
            LEFT JOIN SA3010 SA3 WITH (NOLOCK) ON RTRIM(LTRIM(SA3.A3_COD)) = RTRIM(LTRIM(SC5.C5_VEND1)) AND SA3.D_E_L_E_T_ = ''
            LEFT JOIN SB1010 SB1 WITH (NOLOCK) ON RTRIM(LTRIM(SB1.B1_COD)) = RTRIM(LTRIM(SC6.C6_PRODUTO)) AND SB1.D_E_L_E_T_ = ''
            LEFT JOIN SE4010 SE4 WITH (NOLOCK) ON RTRIM(LTRIM(SE4.E4_CODIGO)) = RTRIM(LTRIM(SC5.C5_CONDPAG)) AND SE4.D_E_L_E_T_ = ''
            WHERE SC5.D_E_L_E_T_ = '' AND (@filial = 'consolidado' OR SC5.C5_FILIAL LIKE @filial + '%') AND SC5.C5_TIPO = 'N' AND SC5.C5_NOTA = '' AND (SC6.C6_BLQ IS NULL OR SC6.C6_BLQ <> 'R') AND SC6.C6_QTDVEN > SC6.C6_QTDENT  
            GROUP BY SC5.C5_FILIAL, SC5.C5_NUM, SC5.C5_EMISSAO, SC5.C5_CLIENTE, SA1.A1_CGC, SA1.A1_NOME, SA1.A1_MUN, SA1.A1_EST, SA1.A1_CEP, SA1.A1_BAIRRO, SA3.A3_NOME, SC5.C5_CONDPAG, SE4.E4_DESCRI, SC9_STATUS.HasCred, SC9_STATUS.HasEst, SC9_STATUS.HasSC9, ROTA_OMS.Roteiro, ROTA_OMS.Percurso
            ORDER BY SC5.C5_EMISSAO ASC
        `);
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
};
app.get('/api/motor-logistico', motorLogisticoHandler);
app.get('/api/motor-logistico/:filial', motorLogisticoHandler);

// ==========================================
// ROTA 3: ANÁLISE E APROVAÇÃO COMERCIAL (DA1)
// ==========================================
const analiseComercialHandler = async (req, res) => {
    try {
        const filialParam = (req.params.filial || 'consolidado').replace(/[^a-zA-Z0-9]/g, '');
        const mesesParam = req.query.meses ? parseInt(req.query.meses) : 999;
        await poolConnect;
        let result = await globalPool.request().input('filial', sql.VarChar, filialParam).input('meses', sql.Int, mesesParam).query(`
            SELECT TOP 5000 
            RTRIM(LTRIM(SC5.C5_NUM)) AS NumPedido, SC5.C5_EMISSAO AS Emissao, RTRIM(LTRIM(SA1.A1_NOME)) AS Cliente,
            RTRIM(LTRIM(SA3.A3_NOME)) AS Vendedor, RTRIM(LTRIM(SC5.C5_TABELA)) AS TabelaERP, RTRIM(LTRIM(SC5.C5_CONDPAG)) AS CondPagtoCod,
            RTRIM(LTRIM(SE4.E4_DESCRI)) AS CondPagto, 30 AS PrazoMedio, (SC6.C6_QTDVEN * SC6.C6_PRCVEN) AS Valor,
            (SC6.C6_QTDVEN * COALESCE(TAB_PRC.DA1_PRCVEN, SC6.C6_PRCVEN)) AS ValorTabelaBase,
            CASE WHEN COALESCE(TAB_PRC.DA1_PRCVEN, 0) > 0 AND SC6.C6_PRCVEN < TAB_PRC.DA1_PRCVEN THEN ROUND(((TAB_PRC.DA1_PRCVEN - SC6.C6_PRCVEN) / TAB_PRC.DA1_PRCVEN) * 100.0, 2) ELSE 0.0 END AS DescGeral,
            RTRIM(LTRIM(SB1.B1_TIPO)) AS TipoProduto, RTRIM(LTRIM(SC6.C6_PRODUTO)) AS CodProduto, RTRIM(LTRIM(SB1.B1_DESC)) AS Produto,
            CAST(SB1.B1_CONV AS FLOAT) AS Conversao, SC6.C6_QTDVEN AS QtdItens, RTRIM(LTRIM(SA1.A1_MUN)) AS Municipio, RTRIM(LTRIM(SA1.A1_EST)) AS Estado,
            RTRIM(LTRIM(SA1.A1_CGC)) AS CNPJ, RTRIM(LTRIM(SA1.A1_COD)) AS CodCliente
            FROM SC5010 SC5 (NOLOCK)
            INNER JOIN SC6010 SC6 (NOLOCK) ON RTRIM(LTRIM(SC6.C6_FILIAL)) = RTRIM(LTRIM(SC5.C5_FILIAL)) AND RTRIM(LTRIM(SC6.C6_NUM)) = RTRIM(LTRIM(SC5.C5_NUM)) AND SC6.D_E_L_E_T_ = ''
            INNER JOIN SA1010 SA1 (NOLOCK) ON RTRIM(LTRIM(SA1.A1_COD)) = RTRIM(LTRIM(SC5.C5_CLIENTE)) AND RTRIM(LTRIM(SA1.A1_LOJA)) = RTRIM(LTRIM(SC5.C5_LOJACLI)) AND SA1.D_E_L_E_T_ = ''
            LEFT JOIN SA3010 SA3 (NOLOCK) ON RTRIM(LTRIM(SA3.A3_COD)) = RTRIM(LTRIM(SC5.C5_VEND1)) AND SA3.D_E_L_E_T_ = ''
            INNER JOIN SB1010 SB1 (NOLOCK) ON RTRIM(LTRIM(SB1.B1_COD)) = RTRIM(LTRIM(SC6.C6_PRODUTO)) AND SB1.D_E_L_E_T_ = ''
            LEFT JOIN SE4010 SE4 (NOLOCK) ON RTRIM(LTRIM(SE4.E4_CODIGO)) = RTRIM(LTRIM(SC5.C5_CONDPAG)) AND SE4.D_E_L_E_T_ = ''
            OUTER APPLY (SELECT TOP 1 DA1_PRCVEN FROM DA1010 (NOLOCK) WHERE DA1_CODTAB = SC5.C5_TABELA AND DA1_CODPRO = SC6.C6_PRODUTO AND D_E_L_E_T_ = '' ORDER BY DA1_DATVIG DESC) TAB_PRC
            WHERE SC5.D_E_L_E_T_ = '' AND (@filial = 'consolidado' OR SC5.C5_FILIAL LIKE @filial + '%') AND (@meses = 999 OR SC5.C5_EMISSAO >= CONVERT(VARCHAR(8), DATEADD(month, -@meses, GETDATE()), 112))
        `);
        res.json({ success: true, data: result.recordset });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
};
app.get('/api/analise-comercial', analiseComercialHandler);
app.get('/api/analise-comercial/:filial', analiseComercialHandler);

// ==========================================
// ROTAS 4, 5, 6, 7, 8: FUNÇÕES BÁSICAS E DE ITEM
// ==========================================
app.get('/api/gestao-titulos', async (req, res) => {
    try {
        if (!req.query.cnpj) return res.status(400).json({ error: "CNPJ obrigatorio" });
        await poolConnect;
        let result = await globalPool.request().input('cnpj', sql.VarChar, req.query.cnpj).query(`SELECT RTRIM(LTRIM(SE1.E1_NUM)) AS doc, RTRIM(LTRIM(SE1.E1_PARCELA)) AS parc, SE1.E1_EMISSAO AS emissao, SE1.E1_VENCTO AS venc, SE1.E1_BAIXA AS pagto, CAST(SE1.E1_VALOR AS FLOAT) AS val, CASE WHEN SE1.E1_BAIXA <> '' THEN CASE WHEN SE1.E1_BAIXA > SE1.E1_VENCTO THEN 'PAGO_ATRASO' ELSE 'PAGO' END ELSE 'ABERTO' END AS status FROM SE1010 SE1 WITH (NOLOCK) INNER JOIN SA1010 SA1 WITH (NOLOCK) ON RTRIM(LTRIM(SA1.A1_COD)) = RTRIM(LTRIM(SE1.E1_CLIENTE)) AND RTRIM(LTRIM(SA1.A1_LOJA)) = RTRIM(LTRIM(SE1.E1_LOJA)) AND SA1.D_E_L_E_T_ = '' WHERE SE1.D_E_L_E_T_ = '' AND RTRIM(LTRIM(SA1.A1_CGC)) = @cnpj ORDER BY SE1.E1_EMISSAO DESC`);
        res.json({ success: true, data: result.recordset });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/faturamento/:cnpj', async (req, res) => {
    try {
        await poolConnect;
        let result = await globalPool.request().input('cnpj', sql.VarChar, req.params.cnpj).query(`SELECT RTRIM(LTRIM(F2.F2_DOC)) AS nf, RTRIM(LTRIM(F2.F2_SERIE)) AS serie, F2.F2_EMISSAO AS emissao, RTRIM(LTRIM(F2.F2_COND)) AS cond, CAST(F2.F2_VALBRUT AS FLOAT) AS valor FROM SF2010 F2 WITH (NOLOCK) INNER JOIN SA1010 SA1 WITH (NOLOCK) ON RTRIM(LTRIM(SA1.A1_COD)) = RTRIM(LTRIM(F2.F2_CLIENTE)) AND RTRIM(LTRIM(SA1.A1_LOJA)) = RTRIM(LTRIM(F2.F2_LOJA)) AND SA1.D_E_L_E_T_ = '' WHERE F2.D_E_L_E_T_ = '' AND RTRIM(LTRIM(SA1.A1_CGC)) = @cnpj ORDER BY F2.F2_EMISSAO DESC`);
        res.json({ success: true, data: result.recordset });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/pedido-itens/:filial/:pedido', async (req, res) => {
    try {
        await poolConnect;
        let result = await globalPool.request().input('filial', sql.VarChar, req.params.filial).input('pedido', sql.VarChar, req.params.pedido).query(`SELECT RTRIM(LTRIM(SC6.C6_ITEM)) AS Item, RTRIM(LTRIM(SC6.C6_PRODUTO)) AS Produto, RTRIM(LTRIM(SB1.B1_DESC)) AS Descricao, CAST(SC6.C6_QTDVEN AS FLOAT) AS QtdVendida, CAST(SC6.C6_PRCVEN AS FLOAT) AS PrecoUnitario, CAST(SC6.C6_QTDVEN * SC6.C6_PRCVEN AS FLOAT) AS ValorTotal, CAST(SB1.B1_PESO AS FLOAT) AS PesoProduto, CAST(COALESCE(SB2.B2_QATU, 0) AS FLOAT) AS SaldoEstoque, CASE WHEN RTRIM(LTRIM(ISNULL(SC6.C6_BLQ, ''))) <> '' THEN 'BLOQUEADO' ELSE 'LIBERADO' END AS StatusEstoque FROM SC6010 SC6 WITH (NOLOCK) LEFT JOIN SB1010 SB1 WITH (NOLOCK) ON RTRIM(LTRIM(SB1.B1_COD)) = RTRIM(LTRIM(SC6.C6_PRODUTO)) AND SB1.D_E_L_E_T_ = '' LEFT JOIN SB2010 SB2 WITH (NOLOCK) ON RTRIM(LTRIM(SB2.B2_COD)) = RTRIM(LTRIM(SC6.C6_PRODUTO)) AND SB2.B2_LOCAL = '01' AND (SB2.B2_FILIAL = '' OR SB2.B2_FILIAL = SC6.C6_FILIAL) AND SB2.D_E_L_E_T_ = '' WHERE SC6.C6_FILIAL = @filial AND SC6.C6_NUM = @pedido AND SC6.D_E_L_E_T_ = '' ORDER BY SC6.C6_ITEM ASC`);
        res.json(result.recordset);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ==========================================
// ROTA DRE FINANCEIRA (INTEGRADA COM CT1)
// ==========================================
const dreFinanceiraHandler = async (req, res) => {
    try {
        const filialParam = (req.params.filial || 'consolidado').replace(/[^a-zA-Z0-9]/g, '');
        await poolConnect;
        let result = await globalPool.request()
            .input('filial', sql.VarChar, filialParam)
            .input('meses', sql.Int, req.query.meses ? parseInt(req.query.meses) : 6)
            .query(`
            WITH RawData AS (
                SELECT 
                    SE5.E5_FILIAL AS Filial, 
                    CASE WHEN LEN(RTRIM(LTRIM(SE5.E5_DATA))) >= 8 AND ISNUMERIC(SUBSTRING(RTRIM(LTRIM(SE5.E5_DATA)), 1, 8)) = 1 THEN SUBSTRING(RTRIM(LTRIM(SE5.E5_DATA)), 1, 6) ELSE SUBSTRING(CONVERT(VARCHAR(10), SE5.E5_DATA, 112), 1, 6) END AS MesChave, 
                    COALESCE(NULLIF(RTRIM(LTRIM(SED.ED_CONTA)), ''), RTRIM(LTRIM(SE5.E5_NATUREZ))) AS Codigo, 
                    COALESCE(NULLIF(RTRIM(LTRIM(CT1.CT1_DESC01)), ''), COALESCE(NULLIF(RTRIM(LTRIM(SED.ED_DESCRIC)), ''), 'NATUREZA ' + RTRIM(LTRIM(SE5.E5_NATUREZ)))) AS Descricao, 
                    COALESCE(
                        NULLIF(RTRIM(LTRIM(CT1_PAI.CT1_DESC01)), ''), 
                        NULLIF(RTRIM(LTRIM(CT1.CT1_SUPER)), ''),
                        RTRIM(LTRIM(COALESCE(NULLIF(RTRIM(LTRIM(SED.ED_PAI)), ''), CASE WHEN CHARINDEX('.', REVERSE(RTRIM(LTRIM(SE5.E5_NATUREZ)))) > 0 THEN LEFT(RTRIM(LTRIM(SE5.E5_NATUREZ)), LEN(RTRIM(LTRIM(SE5.E5_NATUREZ))) - CHARINDEX('.', REVERSE(RTRIM(LTRIM(SE5.E5_NATUREZ))))) WHEN LEN(RTRIM(LTRIM(SE5.E5_NATUREZ))) > 1 THEN LEFT(RTRIM(LTRIM(SE5.E5_NATUREZ)), LEN(RTRIM(LTRIM(SE5.E5_NATUREZ))) - 2) ELSE '' END)))
                    ) AS Pai, 
                    RTRIM(LTRIM(SE5.E5_RECPAG)) AS RecPag, 
                    CAST(SE5.E5_VALOR AS DECIMAL(18,2)) AS Valor 
                FROM SE5010 SE5 WITH (NOLOCK) 
                LEFT JOIN SED010 SED WITH (NOLOCK) ON RTRIM(LTRIM(SED.ED_CODIGO)) = RTRIM(LTRIM(SE5.E5_NATUREZ)) AND SED.D_E_L_E_T_ = '' 
                LEFT JOIN CT1010 CT1 WITH (NOLOCK) ON RTRIM(LTRIM(CT1.CT1_CONTA)) = RTRIM(LTRIM(SED.ED_CONTA)) AND CT1.D_E_L_E_T_ = ''
                LEFT JOIN CT1010 CT1_PAI WITH (NOLOCK) ON RTRIM(LTRIM(CT1_PAI.CT1_CONTA)) = RTRIM(LTRIM(CT1.CT1_SUPER)) AND CT1_PAI.D_E_L_E_T_ = ''
                WHERE SE5.D_E_L_E_T_ = '' AND (@filial = 'consolidado' OR SE5.E5_FILIAL LIKE @filial + '%') AND ((ISDATE(SE5.E5_DATA) = 1 AND CAST(SE5.E5_DATA AS DATE) >= DATEADD(month, -@meses, GETDATE())) OR (ISDATE(SE5.E5_DATA) = 0 AND SE5.E5_DATA >= CONVERT(VARCHAR(8), DATEADD(month, -@meses, GETDATE()), 112)))
            )
            SELECT Filial, MesChave, Codigo, Descricao, Pai, RecPag, SUM(Valor) AS Valor 
            FROM RawData 
            GROUP BY Filial, MesChave, Codigo, Descricao, Pai, RecPag 
            ORDER BY MesChave DESC, Codigo ASC
        `);
        res.json({ success: true, data: result.recordset });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
};
app.get('/api/dre-financeira', dreFinanceiraHandler);
app.get('/api/dre-financeira/:filial', dreFinanceiraHandler);

// ==========================================
// ROTA VISAO RUPTURA
// ==========================================
const visaoRupturaHandler = async (req, res) => {
    try {
        const filialParam = (req.params.filial || 'consolidado').replace(/[^a-zA-Z0-9]/g, '');
        await poolConnect;
        let result = await globalPool.request().input('filial', sql.VarChar, filialParam).query(`SELECT TOP 2000 RTRIM(LTRIM(SC5.C5_FILIAL)) AS Filial, RTRIM(LTRIM(SC5.C5_NUM)) AS Pedido, SC5.C5_EMISSAO AS Emissao, RTRIM(LTRIM(SA3.A3_NOME)) AS Vendedor, RTRIM(LTRIM(SA1.A1_NOME)) AS Cliente, RTRIM(LTRIM(SA1.A1_MUN)) AS Municipio, RTRIM(LTRIM(SA1.A1_EST)) AS Estado, RTRIM(LTRIM(SA1.A1_CGC)) AS CNPJ, RTRIM(LTRIM(SC6.C6_PRODUTO)) AS CodProduto, RTRIM(LTRIM(SB1.B1_DESC)) AS DescProduto, RTRIM(LTRIM(SB1.B1_GRUPO)) AS GrupoProduto, CAST(SB1.B1_CONV AS FLOAT) AS Conversao, CAST(SC6.C6_QTDVEN AS FLOAT) AS QtdPedido, CAST(SC6.C6_QTDENT AS FLOAT) AS QtdEntregue, CAST((SC6.C6_QTDVEN - SC6.C6_QTDENT) AS FLOAT) AS Quantidade, CAST((SC6.C6_QTDVEN - SC6.C6_QTDENT) * SC6.C6_PRCVEN AS FLOAT) AS ValorTotal FROM SC6010 SC6 WITH (NOLOCK) INNER JOIN SC5010 SC5 WITH (NOLOCK) ON RTRIM(LTRIM(SC5.C5_FILIAL)) = RTRIM(LTRIM(SC6.C6_FILIAL)) AND RTRIM(LTRIM(SC5.C5_NUM)) = RTRIM(LTRIM(SC6.C6_NUM)) AND SC5.D_E_L_E_T_ = '' LEFT JOIN SA1010 SA1 WITH (NOLOCK) ON RTRIM(LTRIM(SA1.A1_COD)) = RTRIM(LTRIM(SC5.C5_CLIENTE)) AND RTRIM(LTRIM(SA1.A1_LOJA)) = RTRIM(LTRIM(SC5.C5_LOJACLI)) AND SA1.D_E_L_E_T_ = '' LEFT JOIN SA3010 SA3 WITH (NOLOCK) ON RTRIM(LTRIM(SA3.A3_COD)) = RTRIM(LTRIM(SC5.C5_VEND1)) AND SA3.D_E_L_E_T_ = '' LEFT JOIN SB1010 SB1 WITH (NOLOCK) ON RTRIM(LTRIM(SB1.B1_COD)) = RTRIM(LTRIM(SC6.C6_PRODUTO)) AND SB1.D_E_L_E_T_ = '' WHERE SC6.D_E_L_E_T_ = '' AND (@filial = 'consolidado' OR SC6.C6_FILIAL LIKE @filial + '%') AND SC6.C6_QTDVEN > SC6.C6_QTDENT AND SC5.C5_EMISSAO >= CONVERT(VARCHAR(8), DATEADD(month, -6, GETDATE()), 112) ORDER BY SC5.C5_EMISSAO DESC`);
        res.json({ success: true, data: result.recordset });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
};
app.get('/api/visao-ruptura', visaoRupturaHandler);
app.get('/api/visao-ruptura/:filial', visaoRupturaHandler);

// ==========================================
// SE1 E SE2: CONTAS A RECEBER E PAGAR
// ==========================================
const contasReceberHandler = async (req, res) => {
    try {
        const filialParam = (req.params.filial || 'consolidado').replace(/[^a-zA-Z0-9]/g, '');
        const filtros = req.body || {};
        const dataBase = filtros.dataBase || ''; 
        await poolConnect;
        let reqSql = globalPool.request();

        let query = `
            DECLARE @filial VARCHAR(20) = '${filialParam}';
            DECLARE @data_base DATE = CASE WHEN '${dataBase}' = '' THEN CAST(GETDATE() AS DATE) ELSE CAST('${dataBase}' AS DATE) END;

            SELECT TOP 150000
                RTRIM(LTRIM(SA1.A1_CGC)) AS [CNPJ/CPF],
                RTRIM(LTRIM(SA1.A1_COD)) AS [Codigo],
                RTRIM(LTRIM(SA1.A1_LOJA)) AS [Loja],
                RTRIM(LTRIM(SA1.A1_NOME)) AS [Nome],
                RTRIM(LTRIM(SA1.A1_NREDUZ)) AS [N Fantasia],
                RTRIM(LTRIM(SA1.A1_END)) AS [Endereco],
                RTRIM(LTRIM(SA1.A1_EST)) AS [Estado],
                RTRIM(LTRIM(SA1.A1_MUN)) AS [Municipio],
                RTRIM(LTRIM(SA1.A1_BAIRRO)) AS [Bairro],
                RTRIM(LTRIM(SA1.A1_CEP)) AS [CEP],
                RTRIM(LTRIM(SE1.E1_CLIENTE)) AS [CLIENTE],
                RTRIM(LTRIM(SA1.A1_DDD)) AS [DDD],
                RTRIM(LTRIM(SA1.A1_TEL)) AS [Telefone],
                RTRIM(LTRIM(SA1.A1_TELEX)) AS [Telex],
                RTRIM(LTRIM(SA1.A1_FAX)) AS [FAX],
                RTRIM(LTRIM(SA1.A1_ENDCOB)) AS [End.Cobranca],
                RTRIM(LTRIM(SA1.A1_MUN)) AS [Mun. Cobr.],
                RTRIM(LTRIM(SA1.A1_EST)) AS [Uf de Cobr.],
                RTRIM(LTRIM(SA1.A1_CONTATO)) AS [Contato],
                RTRIM(LTRIM(SE1.E1_FILIAL)) AS [Filial],
                RTRIM(LTRIM(SE1.E1_PREFIXO)) AS [Prefixo],
                RTRIM(LTRIM(SE1.E1_NUM)) AS [No. Titulo],
                RTRIM(LTRIM(SE1.E1_PARCELA)) AS [Parcela],
                RTRIM(LTRIM(SE1.E1_TIPO)) AS [TP],
                RTRIM(LTRIM(SE1.E1_TIPOLIQ)) AS [Tipo Liq],
                RTRIM(LTRIM(SE1.E1_LOJA)) AS [Loja Título],
                RIGHT(SE1.E1_EMISSAO, 2) + '/' + SUBSTRING(SE1.E1_EMISSAO, 5, 2) + '/' + LEFT(SE1.E1_EMISSAO, 4) AS [Data de Emissao],
                RIGHT(SE1.E1_VENCTO, 2) + '/' + SUBSTRING(SE1.E1_VENCTO, 5, 2) + '/' + LEFT(SE1.E1_VENCTO, 4) AS [Vencto Titulo],
                RIGHT(SE1.E1_VENCREA, 2) + '/' + SUBSTRING(SE1.E1_VENCREA, 5, 2) + '/' + LEFT(SE1.E1_VENCREA, 4) AS [Vencto Real],
                CASE 
                    WHEN BAIXAS.UltimaDataBaixa IS NOT NULL THEN RIGHT(BAIXAS.UltimaDataBaixa, 2) + '/' + SUBSTRING(BAIXAS.UltimaDataBaixa, 5, 2) + '/' + LEFT(BAIXAS.UltimaDataBaixa, 4)
                    WHEN RTRIM(LTRIM(SE1.E1_BAIXA)) <> '' THEN RIGHT(SE1.E1_BAIXA, 2) + '/' + SUBSTRING(SE1.E1_BAIXA, 5, 2) + '/' + LEFT(SE1.E1_BAIXA, 4)
                    ELSE ''
                END AS [Data da Baixa],
                CAST(SE1.E1_VALOR AS FLOAT) AS [Valor Original],
                CAST(SE1.E1_SALDO AS FLOAT) AS [Saldo],
                CAST(SE1.E1_MULTA AS FLOAT) AS [Multa],
                RTRIM(LTRIM(SE1.E1_NATUREZ)) AS [Natureza],
                CASE WHEN SE1.E1_SALDO > 0 AND TRY_CAST(NULLIF(RTRIM(LTRIM(SE1.E1_VENCREA)), '') AS DATE) < @data_base THEN CAST(SE1.E1_SALDO AS FLOAT) ELSE 0 END AS [Tit Vencidos, Valor Atual],
                CASE WHEN SE1.E1_SALDO > 0 AND TRY_CAST(NULLIF(RTRIM(LTRIM(SE1.E1_VENCREA)), '') AS DATE) < @data_base THEN CAST(SE1.E1_SALDO + ( (SE1.E1_VALOR * 0.02) + ( ((SE1.E1_VALOR * 0.01) / 30) * DATEDIFF(DAY, TRY_CAST(NULLIF(RTRIM(LTRIM(SE1.E1_VENCREA)), '') AS DATE), @data_base) ) ) AS FLOAT) ELSE 0 END AS [Tit Vencidos, Valor Corrigido],
                CAST(COALESCE(BAIXAS.TotalBaixado, 0) AS FLOAT) AS ValorBaixadoFinal,
                CASE 
                    WHEN SE1.E1_SALDO = 0 THEN CAST(COALESCE(BAIXAS.TotalJuros, 0) AS FLOAT)
                    WHEN SE1.E1_SALDO > 0 AND TRY_CAST(NULLIF(RTRIM(LTRIM(SE1.E1_VENCREA)), '') AS DATE) < @data_base THEN ROUND(CAST((SE1.E1_VALOR * 0.02) + ( ((SE1.E1_VALOR * 0.01) / 30) * DATEDIFF(DAY, TRY_CAST(NULLIF(RTRIM(LTRIM(SE1.E1_VENCREA)), '') AS DATE), @data_base) ) AS FLOAT), 2)
                    ELSE 0
                END AS JurosFinal,
                RTRIM(LTRIM(SE1.E1_PORTADO)) AS [Bco],
                RTRIM(LTRIM(SE1.E1_SITUACA)) AS [St],
                CASE WHEN SE1.E1_SALDO > 0 AND TRY_CAST(NULLIF(RTRIM(LTRIM(SE1.E1_VENCREA)), '') AS DATE) >= @data_base THEN CAST(SE1.E1_SALDO AS FLOAT) ELSE 0 END AS [Titulos a Vencer, Valor Atual],
                RTRIM(LTRIM(SE1.E1_NUMBCO)) AS [Num Banco],
                CASE 
                    WHEN SE1.E1_SALDO = 0 AND TRY_CAST(NULLIF(RTRIM(LTRIM(COALESCE(BAIXAS.UltimaDataBaixa, SE1.E1_BAIXA))), '') AS DATE) > TRY_CAST(NULLIF(RTRIM(LTRIM(SE1.E1_VENCREA)), '') AS DATE) THEN DATEDIFF(DAY, TRY_CAST(NULLIF(RTRIM(LTRIM(SE1.E1_VENCREA)), '') AS DATE), TRY_CAST(NULLIF(RTRIM(LTRIM(COALESCE(BAIXAS.UltimaDataBaixa, SE1.E1_BAIXA))), '') AS DATE))
                    WHEN SE1.E1_SALDO > 0 AND TRY_CAST(NULLIF(RTRIM(LTRIM(SE1.E1_VENCREA)), '') AS DATE) < @data_base THEN DATEDIFF(DAY, TRY_CAST(NULLIF(RTRIM(LTRIM(SE1.E1_VENCREA)), '') AS DATE), @data_base)
                    ELSE 0
                END AS [Dias Atraso],
                RTRIM(LTRIM(SE1.E1_HIST)) AS [Historico],
                CASE WHEN SE1.E1_SALDO > 0 AND TRY_CAST(NULLIF(RTRIM(LTRIM(SE1.E1_VENCREA)), '') AS DATE) < @data_base THEN CAST(SE1.E1_SALDO + ( (SE1.E1_VALOR * 0.02) + ( ((SE1.E1_VALOR * 0.01) / 30) * DATEDIFF(DAY, TRY_CAST(NULLIF(RTRIM(LTRIM(SE1.E1_VENCREA)), '') AS DATE), @data_base) ) ) AS FLOAT) ELSE CAST(SE1.E1_SALDO AS FLOAT) END AS [(Vencidos+Vencer)],
                RTRIM(LTRIM(SE1.E1_VEND1)) AS [Vendedor],
                RTRIM(LTRIM(SA1.A1_EMAIL)) AS [E-Mail],
                CASE WHEN SE1.E1_SALDO = 0 THEN 'Baixado' WHEN TRY_CAST(NULLIF(RTRIM(LTRIM(SE1.E1_VENCREA)), '') AS DATE) < @data_base THEN 'Vencido' ELSE 'A Vencer' END AS [status]
            FROM SE1010 SE1 WITH (NOLOCK)
            INNER JOIN SA1010 SA1 WITH (NOLOCK) 
                ON SA1.A1_COD = SE1.E1_CLIENTE AND SA1.A1_LOJA = SE1.E1_LOJA AND SA1.D_E_L_E_T_ = ''
            OUTER APPLY (
                SELECT SUM(T.E5_VALOR) AS TotalBaixado, SUM(T.E5_VLJUROS) AS TotalJuros, MAX(T.E5_DATA) AS UltimaDataBaixa
                FROM (
                    SELECT SE5.E5_VALOR, SE5.E5_VLJUROS, SE5.E5_DATA FROM SE5010 SE5 WITH (NOLOCK)
                    WHERE SE5.E5_FILIAL = SE1.E1_FILIAL AND SE5.E5_PREFIXO = SE1.E1_PREFIXO AND SE5.E5_NUMERO = SE1.E1_NUM AND SE5.E5_PARCELA = SE1.E1_PARCELA AND SE5.E5_TIPODOC <> 'MT' AND SE5.D_E_L_E_T_ = ''
                    UNION ALL
                    SELECT SE5.E5_VALOR, SE5.E5_VLJUROS, SE5.E5_DATA FROM SE5010 SE5 WITH (NOLOCK)
                    WHERE SE5.E5_FILIAL = '' AND SE5.E5_PREFIXO = SE1.E1_PREFIXO AND SE5.E5_NUMERO = SE1.E1_NUM AND SE5.E5_PARCELA = SE1.E1_PARCELA AND SE5.E5_TIPODOC <> 'MT' AND SE5.D_E_L_E_T_ = ''
                ) AS T
            ) BAIXAS
            WHERE SE1.D_E_L_E_T_ = '' AND (@filial = 'consolidado' OR SE1.E1_FILIAL LIKE @filial + '%')
        `;

        if (filtros.cliente) { query += ` AND SA1.A1_NOME LIKE '%' + @cliente + '%' `; reqSql.input('cliente', sql.VarChar, filtros.cliente); }
        if (filtros.cod_cliente) { query += ` AND SA1.A1_COD LIKE '%' + @cod_cliente + '%' `; reqSql.input('cod_cliente', sql.VarChar, filtros.cod_cliente); }
        if (filtros.fantasia) { query += ` AND SA1.A1_NREDUZ LIKE '%' + @fantasia + '%' `; reqSql.input('fantasia', sql.VarChar, filtros.fantasia); }
        if (filtros.vendedor) { query += ` AND SE1.E1_VEND1 LIKE '%' + @vendedor + '%' `; reqSql.input('vendedor', sql.VarChar, filtros.vendedor); }
        if (filtros.titulo) { query += ` AND SE1.E1_NUM LIKE '%' + @titulo + '%' `; reqSql.input('titulo', sql.VarChar, filtros.titulo); }
        if (filtros.tipo_doc) { query += ` AND SE1.E1_TIPO LIKE '%' + @tipo_doc + '%' `; reqSql.input('tipo_doc', sql.VarChar, filtros.tipo_doc); }
        if (filtros.banco) { query += ` AND (SE1.E1_PORTADO LIKE '%' + @banco + '%' OR SE1.E1_NUMBCO LIKE '%' + @banco + '%') `; reqSql.input('banco', sql.VarChar, filtros.banco); }
        
        if (filtros.status) { 
            if (filtros.status === 'BAIXADO') query += ` AND SE1.E1_SALDO = 0 `; 
            else if (filtros.status === 'VENCIDO') query += ` AND SE1.E1_SALDO > 0 AND TRY_CAST(NULLIF(RTRIM(LTRIM(SE1.E1_VENCREA)), '') AS DATE) < @data_base `; 
            else if (filtros.status === 'A VENCER') query += ` AND SE1.E1_SALDO > 0 AND TRY_CAST(NULLIF(RTRIM(LTRIM(SE1.E1_VENCREA)), '') AS DATE) >= @data_base `; 
            else if (filtros.status === 'VENCIDOS/A VENCER') query += ` AND SE1.E1_SALDO > 0 `; 
        }
        
        const applyDateFilter = (field, prefix, fObj) => { 
            if (!fObj) return; 
            if (fObj.de) { query += ` AND ${field} >= @${prefix}_de `; reqSql.input(`${prefix}_de`, sql.VarChar, fObj.de); } 
            if (fObj.ate) { query += ` AND ${field} <= @${prefix}_ate `; reqSql.input(`${prefix}_ate`, sql.VarChar, fObj.ate); } 
            if (fObj.meses && fObj.meses.length > 0) { const list = fObj.meses.map(m => `'${m.replace(/-/g, '')}'`).join(','); query += ` AND SUBSTRING(${field}, 1, 6) IN (${list}) `; } 
        };
        
        applyDateFilter('SE1.E1_EMISSAO', 'emis', filtros.emis);
        applyDateFilter('SE1.E1_VENCTO', 'venc_orig', filtros.venc_orig);
        applyDateFilter('SE1.E1_VENCREA', 'venc_real', filtros.venc_real);
        
        if (filtros.baixa && (filtros.baixa.de || filtros.baixa.ate || (filtros.baixa.meses && filtros.baixa.meses.length > 0))) { 
            query += ` AND SE1.E1_SALDO = 0 `; 
            applyDateFilter('COALESCE(BAIXAS.UltimaDataBaixa, SE1.E1_BAIXA)', 'baixa', filtros.baixa); 
        }
        
        query += ` ORDER BY SE1.E1_FILIAL, SE1.E1_CLIENTE, SE1.E1_EMISSAO DESC OPTION (RECOMPILE)`;
        
        let result = await reqSql.query(query);
        res.json({ success: true, data: result.recordset });
    } catch (err) { 
        console.error("Erro SQL Filtro Contas a Receber:", err); 
        res.status(500).json({ success: false, error: err.message }); 
    }
};

const contasPagarHandler = async (req, res) => {
    try {
        const filialParam = (req.params.filial || 'consolidado').replace(/[^a-zA-Z0-9]/g, '');
        const filtros = req.body || {};
        const dataBase = filtros.dataBase || ''; 
        await poolConnect;
        let reqSql = globalPool.request();
        
        let query = `
            DECLARE @filial VARCHAR(20) = '${filialParam}';
            DECLARE @data_base DATE = CASE WHEN '${dataBase}' = '' THEN CAST(GETDATE() AS DATE) ELSE CAST('${dataBase}' AS DATE) END;

            SELECT TOP 150000
                RTRIM(LTRIM(SA2.A2_CGC)) AS [CNPJ/CPF],
                RTRIM(LTRIM(SA2.A2_COD)) AS [Codigo],
                RTRIM(LTRIM(SA2.A2_LOJA)) AS [Loja],
                RTRIM(LTRIM(SA2.A2_NOME)) AS [Nome],
                RTRIM(LTRIM(SE2.E2_FILIAL)) AS [Filial],
                RTRIM(LTRIM(SE2.E2_PREFIXO)) AS [Prefixo],
                RTRIM(LTRIM(SE2.E2_NUM)) AS [No. Titulo],
                RTRIM(LTRIM(SE2.E2_PARCELA)) AS [Parcela],
                RTRIM(LTRIM(SE2.E2_TIPO)) AS [TP],
                RIGHT(SE2.E2_EMISSAO, 2) + '/' + SUBSTRING(SE2.E2_EMISSAO, 5, 2) + '/' + LEFT(SE2.E2_EMISSAO, 4) AS [Data de Emissao],
                RIGHT(SE2.E2_VENCTO, 2) + '/' + SUBSTRING(SE2.E2_VENCTO, 5, 2) + '/' + LEFT(SE2.E2_VENCTO, 4) AS [Vencto Titulo],
                RIGHT(SE2.E2_VENCREA, 2) + '/' + SUBSTRING(SE2.E2_VENCREA, 5, 2) + '/' + LEFT(SE2.E2_VENCREA, 4) AS [Vencto Real],
                CASE 
                    WHEN BAIXAS.UltimaDataBaixa IS NOT NULL THEN RIGHT(BAIXAS.UltimaDataBaixa, 2) + '/' + SUBSTRING(BAIXAS.UltimaDataBaixa, 5, 2) + '/' + LEFT(BAIXAS.UltimaDataBaixa, 4)
                    WHEN RTRIM(LTRIM(SE2.E2_BAIXA)) <> '' THEN RIGHT(SE2.E2_BAIXA, 2) + '/' + SUBSTRING(SE2.E2_BAIXA, 5, 2) + '/' + LEFT(SE2.E2_BAIXA, 4)
                    ELSE ''
                END AS [Data da Baixa],
                CAST(SE2.E2_VALOR AS FLOAT) AS [Valor Original],
                CASE WHEN SE2.E2_SALDO > 0 AND TRY_CAST(NULLIF(RTRIM(LTRIM(SE2.E2_VENCREA)), '') AS DATE) < @data_base THEN CAST(SE2.E2_SALDO AS FLOAT) ELSE 0 END AS [Tit Vencidos, Valor Atual],
                CASE WHEN SE2.E2_SALDO > 0 AND TRY_CAST(NULLIF(RTRIM(LTRIM(SE2.E2_VENCREA)), '') AS DATE) < @data_base THEN CAST(SE2.E2_SALDO + ( (SE2.E2_VALOR * 0.02) + ( ((SE2.E2_VALOR * 0.01) / 30) * DATEDIFF(DAY, TRY_CAST(NULLIF(RTRIM(LTRIM(SE2.E2_VENCREA)), '') AS DATE), @data_base) ) ) AS FLOAT) ELSE 0 END AS [Tit Vencidos, Valor Corrigido],
                CAST(COALESCE(BAIXAS.TotalBaixado, 0) AS FLOAT) AS ValorBaixadoFinal,
                CASE 
                    WHEN SE2.E2_SALDO = 0 THEN CAST(COALESCE(BAIXAS.TotalJuros, 0) AS FLOAT)
                    WHEN SE2.E2_SALDO > 0 AND TRY_CAST(NULLIF(RTRIM(LTRIM(SE2.E2_VENCREA)), '') AS DATE) < @data_base THEN ROUND(CAST((SE2.E2_VALOR * 0.02) + ( ((SE2.E2_VALOR * 0.01) / 30) * DATEDIFF(DAY, TRY_CAST(NULLIF(RTRIM(LTRIM(SE2.E2_VENCREA)), '') AS DATE), @data_base) ) AS FLOAT), 2)
                    ELSE 0
                END AS JurosFinal,
                RTRIM(LTRIM(SE2.E2_PORTADO)) AS [Bco],
                CASE WHEN SE2.E2_SALDO > 0 AND TRY_CAST(NULLIF(RTRIM(LTRIM(SE2.E2_VENCREA)), '') AS DATE) >= @data_base THEN CAST(SE2.E2_SALDO AS FLOAT) ELSE 0 END AS [Titulos a Vencer, Valor Atual],
                RTRIM(LTRIM(SE2.E2_NUMBCO)) AS [Num Banco],
                RTRIM(LTRIM(SE2.E2_HIST)) AS [Historico],
                CASE WHEN SE2.E2_SALDO = 0 THEN 'Baixado' WHEN TRY_CAST(NULLIF(RTRIM(LTRIM(SE2.E2_VENCREA)), '') AS DATE) < @data_base THEN 'Vencido' ELSE 'A Vencer' END AS [status]
            FROM SE2010 SE2 WITH (NOLOCK)
            INNER JOIN SA2010 SA2 WITH (NOLOCK) 
                ON SA2.A2_COD = SE2.E2_FORNECE AND SA2.A2_LOJA = SE2.E2_LOJA AND SA2.D_E_L_E_T_ = ''
            OUTER APPLY (
                SELECT SUM(T.E5_VALOR) AS TotalBaixado, SUM(T.E5_VLJUROS) AS TotalJuros, MAX(T.E5_DATA) AS UltimaDataBaixa
                FROM (
                    SELECT SE5.E5_VALOR, SE5.E5_VLJUROS, SE5.E5_DATA FROM SE5010 SE5 WITH (NOLOCK)
                    WHERE SE5.E5_FILIAL = SE2.E2_FILIAL AND SE5.E5_PREFIXO = SE2.E2_PREFIXO AND SE5.E5_NUMERO = SE2.E2_NUM AND SE5.E5_PARCELA = SE2.E2_PARCELA AND SE5.E5_TIPODOC <> 'MT' AND SE5.D_E_L_E_T_ = ''
                    UNION ALL
                    SELECT SE5.E5_VALOR, SE5.E5_VLJUROS, SE5.E5_DATA FROM SE5010 SE5 WITH (NOLOCK)
                    WHERE SE5.E5_FILIAL = '' AND SE5.E5_PREFIXO = SE2.E2_PREFIXO AND SE5.E5_NUMERO = SE2.E2_NUM AND SE5.E5_PARCELA = SE2.E2_PARCELA AND SE5.E5_TIPODOC <> 'MT' AND SE5.D_E_L_E_T_ = ''
                ) AS T
            ) BAIXAS
            WHERE SE2.D_E_L_E_T_ = '' AND (@filial = 'consolidado' OR SE2.E2_FILIAL LIKE @filial + '%')
        `;

        if (filtros.fornecedor) { query += ` AND SA2.A2_NOME LIKE '%' + @fornecedor + '%' `; reqSql.input('fornecedor', sql.VarChar, filtros.fornecedor); }
        if (filtros.titulo) { query += ` AND SE2.E2_NUM LIKE '%' + @titulo + '%' `; reqSql.input('titulo', sql.VarChar, filtros.titulo); }
        
        if (filtros.status) { 
            if (filtros.status === 'BAIXADO') query += ` AND SE2.E2_SALDO = 0 `; 
            else if (filtros.status === 'VENCIDO') query += ` AND SE2.E2_SALDO > 0 AND TRY_CAST(NULLIF(RTRIM(LTRIM(SE2.E2_VENCREA)), '') AS DATE) < @data_base `; 
            else if (filtros.status === 'A VENCER') query += ` AND SE2.E2_SALDO > 0 AND TRY_CAST(NULLIF(RTRIM(LTRIM(SE2.E2_VENCREA)), '') AS DATE) >= @data_base `; 
        }
        
        query += ` ORDER BY SE2.E2_FILIAL, SE2.E2_FORNECE, SE2.E2_EMISSAO DESC OPTION (RECOMPILE)`;
        
        let result = await reqSql.query(query);
        res.json({ success: true, data: result.recordset });
    } catch (err) { 
        console.error("Erro SQL Filtro Contas a Pagar:", err); 
        res.status(500).json({ success: false, error: err.message }); 
    }
};

const bancosHandler = async (req, res) => {
    try {
        await poolConnect;
        let result = await globalPool.request().query(`SELECT RTRIM(LTRIM(A6_COD)) AS Banco, RTRIM(LTRIM(A6_AGENCIA)) AS Agencia, RTRIM(LTRIM(A6_NUMCON)) AS Conta, RTRIM(LTRIM(A6_NOME)) AS NomeConta FROM SA6010 WITH (NOLOCK) WHERE D_E_L_E_T_ = '' ORDER BY A6_COD ASC, A6_AGENCIA ASC`);
        res.json({ success: true, data: result.recordset });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
};

const produtosHandler = async (req, res) => {
    try {
        const filialParam = (req.params.filial || '01').replace(/[^a-zA-Z0-9]/g, '');
        await poolConnect;
        let result = await globalPool.request().input('filial', sql.VarChar, filialParam).query(`SELECT TOP 10000 RTRIM(LTRIM(SB1.B1_COD)) AS codigo, RTRIM(LTRIM(SB1.B1_DESC)) AS nome, RTRIM(LTRIM(SB1.B1_FABRIC)) AS fabricante, RTRIM(LTRIM(COALESCE(NULLIF(SB1.B1_GRUPO, ''), 'GERAL'))) AS grupo, RTRIM(LTRIM(COALESCE(NULLIF(SB1.B1_TIPO, ''), 'PADRÃO'))) AS tipo, RTRIM(LTRIM(COALESCE(NULLIF(SB1.B1_CLASIC, ''), 'VAZIO_ERP'))) AS classe, CAST(COALESCE(NULLIF(SB2.B2_CM1, 0), SB1.B1_UPRC, 0) AS FLOAT) AS custo FROM SB1010 SB1 WITH (NOLOCK) LEFT JOIN SB2010 SB2 WITH (NOLOCK) ON RTRIM(LTRIM(SB2.B2_COD)) = RTRIM(LTRIM(SB1.B1_COD)) AND SB2.B2_LOCAL = '01' AND (SB2.B2_FILIAL = @filial OR SB2.B2_FILIAL = '') AND SB2.D_E_L_E_T_ = '' WHERE SB1.D_E_L_E_T_ = '' AND SB1.B1_MSBLQL <> '1' ORDER BY SB1.B1_COD`);
        res.json({ success: true, data: result.recordset });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
};

// ==========================================
// ROTA 11, 12, 13, 14: EXTRATO, PRODUTOS, VENDAS
// ==========================================
app.get('/api/bancos-ativos', bancosHandler);
app.get('/api/bancos-ativos/:filial', bancosHandler);

app.get('/api/extrato-financeiro', async (req, res) => {
    try {
        const banco = req.query.banco || ''; const conta = req.query.conta || ''; const deData = req.query.deData || ''; const ateData = req.query.ateData || '';
        if (!banco || !conta || !deData || !ateData) return res.status(400).json({ success: false, error: "Faltam parâmetros." });
        await poolConnect;
        let sqlSaldoAnterior = `SELECT ISNULL(SUM(CASE WHEN RTRIM(LTRIM(E5_RECPAG)) = 'R' THEN E5_VALOR ELSE -E5_VALOR END), 0) AS SaldoAnterior FROM SE5010 WITH (NOLOCK) WHERE D_E_L_E_T_ = '' AND E5_BANCO = @banco AND REPLACE(REPLACE(RTRIM(LTRIM(E5_CONTA)), '-', ''), ' ', '') = REPLACE(REPLACE(RTRIM(LTRIM(@conta)), '-', ''), ' ', '') AND E5_DATA < @deData AND E5_TIPODOC <> 'MT'`;
        let sqlMovimentos = `SELECT E5_DATA AS DataMov, RTRIM(LTRIM(E5_NUMERO)) AS Numero, RTRIM(LTRIM(E5_DOCUMEN)) AS Documento, RTRIM(LTRIM(E5_TIPODOC)) AS TipoDoc, RTRIM(LTRIM(E5_RECPAG)) AS RecPag, CAST(E5_VALOR AS FLOAT) AS Valor, RTRIM(LTRIM(E5_NATUREZ)) AS Natureza, COALESCE(RTRIM(LTRIM(SED.ED_DESCRIC)), 'S/ NATUREZA') AS DescNatureza, RTRIM(LTRIM(E5_HISTOR)) AS Historico, RTRIM(LTRIM(E5_BENEF)) AS Favorecido FROM SE5010 SE5 WITH (NOLOCK) LEFT JOIN SED010 SED WITH (NOLOCK) ON RTRIM(LTRIM(SED.ED_CODIGO)) = RTRIM(LTRIM(SE5.E5_NATUREZ)) AND SED.D_E_L_E_T_ = '' WHERE SE5.D_E_L_E_T_ = '' AND SE5.E5_BANCO = @banco AND REPLACE(REPLACE(RTRIM(LTRIM(SE5.E5_CONTA)), '-', ''), ' ', '') = REPLACE(REPLACE(RTRIM(LTRIM(@conta)), '-', ''), ' ', '') AND SE5.E5_DATA >= @deData AND SE5.E5_DATA <= @ateData AND SE5.E5_TIPODOC <> 'MT' ORDER BY SE5.E5_DATA ASC, SE5.E5_RECPAG DESC OPTION (RECOMPILE)`;
        const request = globalPool.request().input('banco', sql.VarChar, banco).input('conta', sql.VarChar, conta).input('deData', sql.VarChar, deData).input('ateData', sql.VarChar, ateData);
        const result = await request.query(sqlSaldoAnterior + ';' + sqlMovimentos);
        res.json({ success: true, saldoInicial: result.recordsets[0][0].SaldoAnterior, lancamentos: result.recordsets[1] });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/produtos', produtosHandler);
app.get('/api/produtos/:filial', produtosHandler);

app.get('/api/estatisticas-vendas/consolidado', async (req, res) => {
    try {
        const deData = (req.query.deData || '').replace(/-/g, ''); const ateData = (req.query.ateData || '').replace(/-/g, '');
        if (!deData || !ateData) return res.status(400).json({ success: false, error: "Datas obrigatórias." });
        await poolConnect;
        let result = await globalPool.request().input('de', sql.VarChar, deData).input('ate', sql.VarChar, ateData).query(`SELECT RTRIM(LTRIM(D2_COD)) AS CodigoProduto, CAST(SUM(D2_TOTAL) / SUM(D2_QUANT) AS FLOAT) AS PrecoMedioVenda, CAST(SUM(D2_QUANT) AS FLOAT) AS QuantidadeTotal FROM SD2010 WITH (NOLOCK) WHERE D_E_L_E_T_ = '' AND D2_EMISSAO >= @de AND D2_EMISSAO <= @ate AND D2_QUANT > 0 AND D2_TOTAL > 0 GROUP BY RTRIM(LTRIM(D2_COD))`);
        res.json({ success: true, data: result.recordset });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
});

// ==========================================
// ROTA 15: ACOMPANHAMENTO DE BAIXAS (SE5 x SE1) 
// ==========================================
const acompanhamentoBaixasHandler = async (req, res) => {
    try {
        const filialParam = (req.params.filial || 'consolidado').replace(/[^a-zA-Z0-9]/g, '');
        const filtros = req.body || {};
        const deBaixa = filtros.deBaixa || '';
        const ateBaixa = filtros.ateBaixa || '';

        if(!deBaixa || !ateBaixa) return res.status(400).json({ success: false, error: "Datas de baixa obrigatórias." });

        await poolConnect;
        let reqSql = globalPool.request();
        reqSql.input('deBaixa', sql.VarChar, deBaixa);
        reqSql.input('ateBaixa', sql.VarChar, ateBaixa);

        let query = `
            SELECT TOP 100000
                RTRIM(LTRIM(SE5.E5_FILIAL)) AS Filial,
                RTRIM(LTRIM(SE5.E5_PREFIXO)) AS Prefixo,
                RTRIM(LTRIM(SE5.E5_NUMERO)) AS Documento,
                RTRIM(LTRIM(SE5.E5_PARCELA)) AS Parcela,
                RIGHT(SE1.E1_VENCREA, 2) + '/' + SUBSTRING(SE1.E1_VENCREA, 5, 2) + '/' + LEFT(SE1.E1_VENCREA, 4) AS VenctoReal,
                SE1.E1_VENCREA AS VenctoRealRaw,
                RIGHT(SE5.E5_DATA, 2) + '/' + SUBSTRING(SE5.E5_DATA, 5, 2) + '/' + LEFT(SE5.E5_DATA, 4) AS DataBaixa,
                SE5.E5_DATA AS DataBaixaRaw,
                RTRIM(LTRIM(SA1.A1_CGC)) AS CnpjCliente,
                RTRIM(LTRIM(SA1.A1_COD)) AS CodCliente,
                RTRIM(LTRIM(SA1.A1_NOME)) AS NomeCliente,
                RTRIM(LTRIM(SE1.E1_VEND1)) AS Vendedor,
                CAST(SE1.E1_VALOR AS FLOAT) AS ValorOriginal,
                CAST(COALESCE((
                    SELECT SUM(S_PREV.E5_VALOR - S_PREV.E5_VLJUROS - S_PREV.E5_VLMULTA + S_PREV.E5_VLDESCO)
                    FROM SE5010 S_PREV WITH (NOLOCK)
                    WHERE S_PREV.E5_FILIAL = SE5.E5_FILIAL
                      AND S_PREV.E5_PREFIXO = SE5.E5_PREFIXO
                      AND S_PREV.E5_NUMERO = SE5.E5_NUMERO
                      AND S_PREV.E5_PARCELA = SE5.E5_PARCELA
                      AND S_PREV.E5_TIPODOC <> 'MT'
                      AND S_PREV.E5_RECPAG = 'R'
                      AND S_PREV.D_E_L_E_T_ = ''
                      AND (S_PREV.E5_DATA < SE5.E5_DATA OR (S_PREV.E5_DATA = SE5.E5_DATA AND S_PREV.R_E_C_N_O_ < SE5.R_E_C_N_O_))
                ), 0) AS FLOAT) AS AmortizadoAnterior,
                CAST((SE5.E5_VALOR - SE5.E5_VLJUROS - SE5.E5_VLMULTA + SE5.E5_VLDESCO) AS FLOAT) AS Amortizado,
                CAST(SE5.E5_VLJUROS AS FLOAT) AS Juros,
                CAST(SE5.E5_VLMULTA AS FLOAT) AS Multa,
                CAST(SE5.E5_VLDESCO AS FLOAT) AS Desconto,
                CAST(SE5.E5_VALOR AS FLOAT) AS TotalRecebido,
                RTRIM(LTRIM(SE5.E5_BANCO)) AS Banco
            FROM SE5010 SE5 WITH (NOLOCK)
            INNER JOIN SE1010 SE1 WITH (NOLOCK)
                ON SE1.E1_FILIAL = SE5.E5_FILIAL
               AND SE1.E1_PREFIXO = SE5.E5_PREFIXO
               AND SE1.E1_NUM = SE5.E5_NUMERO
               AND SE1.E1_PARCELA = SE5.E5_PARCELA
               AND SE1.D_E_L_E_T_ = ''
            INNER JOIN SA1010 SA1 WITH (NOLOCK) 
                ON SA1.A1_COD = SE1.E1_CLIENTE AND SA1.A1_LOJA = SE1.E1_LOJA AND SA1.D_E_L_E_T_ = ''
            WHERE SE5.D_E_L_E_T_ = ''
              AND SE5.E5_TIPODOC <> 'MT'
              AND SE5.E5_RECPAG = 'R'
              AND SE5.E5_DATA >= @deBaixa 
              AND SE5.E5_DATA <= @ateBaixa
        `;

        if (filialParam !== 'consolidado') { query += ` AND SE5.E5_FILIAL LIKE '${filialParam}%' `; }
        query += ` ORDER BY SE5.E5_DATA DESC, SE5.E5_NUMERO ASC OPTION (RECOMPILE) `;

        let result = await reqSql.query(query);
        res.json({ success: true, data: result.recordset });
    } catch (err) { res.status(500).json({ success: false, error: err.message }); }
};

app.post('/api/se1-consultar', contasReceberHandler);
app.post('/api/se1-consultar/:filial', contasReceberHandler);
app.post('/api/se2-consultar', contasPagarHandler);
app.post('/api/se2-consultar/:filial', contasPagarHandler);
app.post('/api/acompanhamento-baixas', acompanhamentoBaixasHandler);
app.post('/api/acompanhamento-baixas/:filial', acompanhamentoBaixasHandler);

app.get('/api/health', (req, res) => res.json({ status: "OK", version: "V58", dt: new Date() }));

app.listen(port, () => {
    console.log(`\n?? API Mestre LEME ERP (V58 - Fix Routings Final) iniciada com sucesso na porta ${port}!`);
});