const mssql = require("mssql");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const cron = require("node-cron");
const axios = require("axios");
const crypto = require("crypto");
const nodemailer = require("nodemailer");
const qs = require("qs");
const fs = require("fs");
const path = require("path");
const { parse } = require("json2csv");
require("dotenv").config();
const https = require("https");

const tls = require('tls');
tls.DEFAULT_MIN_VERSION = 'TLSv1';  // Allow TLS 1.0 and 1.1
tls.DEFAULT_MAX_VERSION = 'TLSv1.2'; // Still allow up to 1.2
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const agent = new https.Agent({ family: 4 });

const rtweb = process.env.DB_DATABASE2;
const posmain = process.env.DB_DATABASE1;
const db_port1 = 1443; // For posmain database
const db_port2 = 1433; // For rtweb database

const logsDir = path.join(__dirname, "../logs");
const errorLogPath = path.join(logsDir, "error_log.csv");
const successLogPath = path.join(logsDir, "success_log.csv");

// Initialize global connection pool for customer-specific connections
let globalPool;
let isCronRunning = false; // Lock to prevent multiple cron instances

const dbConfig = {
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      server: process.env.DB_SERVER,
      database: process.env.DB_DATABASE1,
      options: {
        encrypt: true,
        trustServerCertificate: true,
      },
      port: parseInt(db_port1),
      connectionTimeout: 30000,
      requestTimeout: 30000,
    };

async function initializeDB(IP) {
  const connection_ip = String(IP).trim();
  if (!connection_ip.match(/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/)) {
    throw new Error(`Invalid IP address: ${connection_ip}`);
  }

  const syncdbConfig = {
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    server: connection_ip,
    database: process.env.DB_DATABASE2,
    options: {
      encrypt: true,
      trustServerCertificate: true,
    },
    port: parseInt(db_port2),
    connectionTimeout: 30000,
    requestTimeout: 30000,
  };

  // Try with encrypt: true
  try {
    if (globalPool) {
      await globalPool.close();
      console.log("Previous global database connection closed");
    }
    globalPool = await mssql.connect(syncdbConfig);
    console.log(`Connected with ENCRYPTION to ${connection_ip}:${db_port2}`);
    return globalPool;
  } catch (error) {
    console.warn(`Encryption failed: ${error.message}`);

    // Try without encryption
    syncdbConfig.options.encrypt = false;
    try {
      globalPool = await mssql.connect(syncdbConfig);
      console.log(`Connected WITHOUT encryption to ${connection_ip}:${db_port2}`);
      return globalPool;
    } catch (noEncryptError) {
      throw new Error(`All connection attempts failed. Encrypt: ${error.message} | NoEncrypt: ${noEncryptError.message}`);
    }
  }
}

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

async function syncDBConnection() {
  let pool;
  try {
    
    pool = await mssql.connect(dbConfig);
    console.log(`Connected to posmain database at ${process.env.DB_SERVER}:${db_port1}`);
    const request = new mssql.Request(pool);
    const dbConnectionResult = await request.query(
      `USE ${posmain};
       SELECT * FROM tb_SYNCDB_USERS`
    );
    if (dbConnectionResult.recordset.length === 0) {
      const msg = `No user details found in tb_SYNCDB_USERS. Database: ${posmain}`;
      await logErrorsToCSV(msg);
      return [];
    }
    console.log("syncDBConnection Data:", dbConnectionResult.recordset);
    return dbConnectionResult.recordset;
  } catch (error) {
    const errorMsg = `Error in syncDBConnection at ${process.env.DB_SERVER}:${db_port1}: ${error.message}`;
    console.error(errorMsg);
    await logErrorsToCSV(errorMsg);
    return [];
  } finally {
    if (pool) await pool.close();
  }
}

async function userItemsDetails(ReceiptDate, ReceiptNo) {
  try {
    const request = new mssql.Request(globalPool);
    const query = `
      USE ${rtweb};
      SELECT Item_Desc, ItemAmt, ItemDiscountAmt 
      FROM tb_OGFITEMSALE 
      WHERE ReceiptDate = @ReceiptDate AND ReceiptNo = @ReceiptNo AND UPLOAD <> 'T';
    `;
    request.input("ReceiptDate", mssql.Date, new Date(ReceiptDate));
    request.input("ReceiptNo", mssql.NVarChar, ReceiptNo);
    const userItemsDetails = await request.query(query);
    if (userItemsDetails.recordset.length === 0) {
      const msg = `No items found for ReceiptDate: ${ReceiptDate}, ReceiptNo: ${ReceiptNo}`;
      console.log(msg);
      return { error: msg };
    }
    return userItemsDetails.recordset;
  } catch (error) {
    const errorMsg = `Error in fetching user items details: ${error.message}`;
    console.error(errorMsg);
    await logErrorsToCSV(errorMsg);
    return { error: errorMsg };
  }
}

async function userPaymentDetails() {
  try {
    const request = new mssql.Request(globalPool);
    const query = `
      USE ${rtweb};
      SELECT 
          ReceiptNo, 
          MAX(ReceiptDate) AS ReceiptDate, 
          MAX(ReceiptTime) AS ReceiptTime, 
          SUM(NoOfItems) AS NoOfItems, 
          MAX(SalesCurrency) AS SalesCurrency, 
          SUM(TotalSalesAmtB4Tax) AS TotalSalesAmtB4Tax, 
          SUM(TotalSalesAmtAfterTax) AS TotalSalesAmtAfterTax, 
          SUM(SalesTaxRate) AS SalesTaxRate, 
          SUM(ServiceChargeAmt) AS ServiceChargeAmt, 
          SUM(PaymentAmt) AS PaymentAmt, 
          MAX(PaymentCurrency) AS PaymentCurrency, 
          (SELECT STUFF(
              (SELECT DISTINCT ',' + t2.PaymentMethod  
               FROM tb_OGFPAYMENT AS t2  
               WHERE t2.ReceiptNo = t1.ReceiptNo  
               FOR XML PATH(''), TYPE).value('.', 'NVARCHAR(MAX)'), 1, 1, '')
          ) AS PaymentMethod, 
          MAX(SalesType) AS SalesType
      FROM tb_OGFPAYMENT AS t1 
      WHERE UPLOAD <> 'T'
      GROUP BY ReceiptNo;
    `;
    console.log("Executing userPaymentDetails query:", query);
    const userPaymentDetails = await request.query(query);
    if (userPaymentDetails.recordset.length === 0) {
      const msg = "Cannot fetch user payment details";
      console.log(msg);
      await logErrorsToCSV(msg);
      return { error: msg };
    }
    return userPaymentDetails.recordset;
  } catch (error) {
    const errorMsg = `Error in fetching user payment details: ${error.message}`;
    console.error(errorMsg);
    await logErrorsToCSV(errorMsg);
    return { error: errorMsg };
  }
}

async function userDetails() {
  try {
    const request = new mssql.Request(globalPool);
    const query = `
      USE ${rtweb};
      SELECT AppCode, PropertyCode, POSInterfaceCode, BatchCode, SalesTaxRate, OAUTH_TOKEN_URL, 
             ClientID, ClientSecret, API_ENDPOINT 
      FROM tb_OGFMAIN;
    `;
    const userDetails = await request.query(query);
    if (userDetails.recordset.length === 0) {
      const msg = "Cannot fetch user details from tb_OGFMAIN";
      console.log(msg);
      await logErrorsToCSV(msg);
      return [];
    }
    const trimmedUserConnectionDetails = userDetails.recordset.map((user) => {
      let trimmedUser = {};
      for (const key in user) {
        trimmedUser[key] = typeof user[key] === "string" ? user[key].trim() : user[key];
      }
      return trimmedUser;
    });
    console.log("userDetails Data:", trimmedUserConnectionDetails);
    return trimmedUserConnectionDetails;
  } catch (error) {
    const errorMsg = `Error in fetching user connection details: ${error.message}`;
    console.error(errorMsg);
    await logErrorsToCSV(errorMsg);
    return [];
  }
}

async function getAccessToken(user) {
  try {
    const data = qs.stringify({
      client_id: user.ClientID,
      client_secret: user.ClientSecret,
      grant_type: "client_credentials",
    });
    const response = await axios.post(user.OAUTH_TOKEN_URL, data, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      httpsAgent: agent,
      timeout: 10000,
    });
    return response.data.access_token;
  } catch (error) {
    const errorMsg = `Error fetching token for ${user.OAUTH_TOKEN_URL}: ${
      error.response ? JSON.stringify(error.response.data) : error.message
    }`;
    await logErrorsToCSV(errorMsg);
    return null;
  }
}

function trimObjectStrings(obj) {
  if (typeof obj !== "object" || obj === null) return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => trimObjectStrings(item));
  }
  return Object.fromEntries(
    Object.entries(obj).map(([key, value]) => [
      key,
      typeof value === "string" ? value.trim() : trimObjectStrings(value),
    ])
  );
}

async function updateTables() {
  try {
    const request = new mssql.Request(globalPool);
    const updatePayment = await request.query(`
      USE ${rtweb};
      UPDATE tb_OGFPAYMENT
      SET UPLOAD = 'T'
      WHERE UPLOAD <> 'T' OR UPLOAD IS NULL;
    `);
    const updateItems = await request.query(`
      USE ${rtweb};
      UPDATE tb_OGFITEMSALE
      SET UPLOAD = 'T'
      WHERE UPLOAD <> 'T' OR UPLOAD IS NULL;
    `);
    const paymentRows = updatePayment.rowsAffected[0];
    const itemsRows = updateItems.rowsAffected[0];
    if (paymentRows === 0 && itemsRows === 0) {
      return {
        message: "No rows were updated in tb_OGFPAYMENT or tb_OGFITEMSALE",
        paymentRowsAffected: paymentRows,
        itemsRowsAffected: itemsRows,
      };
    }
    return {
      message: "Tables updated successfully",
      paymentRowsAffected: paymentRows,
      itemsRowsAffected: itemsRows,
    };
  } catch (error) {
    const errorMsg = `Could not update tables: ${error.message}`;
    console.error(errorMsg);
    await logErrorsToCSV(errorMsg);
    return { message: errorMsg };
  }
}

function getSriLankaTime() {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Colombo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date()).replace(",", "");
}

async function logErrorsToCSV(errorMessage) {
  const errorData = {
    message: errorMessage,
    date_time: getSriLankaTime(),
  };
  const headersNeeded = !fs.existsSync(errorLogPath);
  const csv = parse([errorData], { header: headersNeeded });
  fs.appendFileSync(errorLogPath, csv + "\n", "utf8");
}

async function logSuccessToCSV(successMessage) {
  const successData = {
    message: successMessage,
    date_time: getSriLankaTime(),
  };
  const headersNeeded = !fs.existsSync(successLogPath);
  const csv = parse([successData], { header: headersNeeded });
  fs.appendFileSync(successLogPath, csv + "\n", "utf8");
}

async function syncDB() {
  try {
    let syncdbIp = null;
    let syncdbPort = null;
    const dbConnectionData = await syncDBConnection();
    console.log("syncDB - DB Connection Data:", dbConnectionData);

    if (!dbConnectionData || dbConnectionData.length === 0) {
      const msg = "No customer data found.";
      await logErrorsToCSV(msg);
      return { message: msg };
    }

    const apiResponses = [];
    const errors = [];

    for (const customer of dbConnectionData) {
      syncdbIp = customer.IP ? customer.IP.trim() : null;
      syncdbPort = customer.PORT ? parseInt(customer.PORT.trim()) : null;

      if (!syncdbIp || !syncdbPort) {
        const errorMsg = `Invalid IP (${syncdbIp}) or Port (${syncdbPort}) for customer`;
        console.error(errorMsg);
        errors.push(errorMsg);
        await logErrorsToCSV(errorMsg);
        continue;
      }

      // Initialize DB connection for this customer's IP
      try {
        await initializeDB(syncdbIp);
      } catch (error) {
        const errorMsg = `Failed to initialize database connection for IP ${syncdbIp}: ${error.message}`;
        console.error(errorMsg);
        errors.push(errorMsg);
        await logErrorsToCSV(errorMsg);
        continue;
      }

      const users = await userDetails();
      console.log("syncDB - Users:", users);
      const payments = await userPaymentDetails();
      console.log("syncDB - Payments:", payments);

      if (payments.error) {
        errors.push(payments.error);
        await logErrorsToCSV(payments.error);
        continue;
      }

      const result = [];

      for (const user of users) {
        const { SalesTaxRate, OAUTH_TOKEN_URL, API_ENDPOINT, ...filteredUser } = user;
        const userResult = {
          AppCode: filteredUser.AppCode,
          PropertyCode: filteredUser.PropertyCode,
          ClientID: filteredUser.ClientID,
          ClientSecret: filteredUser.ClientSecret,
          POSInterfaceCode: filteredUser.POSInterfaceCode,
          BatchCode: filteredUser.BatchCode,
          PosSales: [],
        };

        for (const payment of payments) {
          const { IDX, UPLOAD, Insert_Time, ...filteredPayment } = payment;
          const formattedDate = new Date(payment.ReceiptDate)
            .toLocaleDateString("en-GB")
            .replace(/\//g, "/");
          const formattedTime = new Date(payment.ReceiptTime).toLocaleTimeString("en-GB", {
            hour12: false,
          });
          const newPaymentDetails = {
            PropertyCode: filteredUser.PropertyCode,
            POSInterfaceCode: filteredUser.POSInterfaceCode,
            ...filteredPayment,
            ReceiptDate: formattedDate,
            ReceiptTime: formattedTime,
          };

          const items = await userItemsDetails(payment.ReceiptDate, payment.ReceiptNo);
          if (items.error) {
            errors.push(items.error);
            await logErrorsToCSV(items.error);
            continue;
          }

          const paymentWithItems = {
            ...newPaymentDetails,
            Items: items,
          };
          userResult.PosSales.push(trimObjectStrings(paymentWithItems));
        }

        result.push(trimObjectStrings(userResult));

        const token = await getAccessToken(user);
        if (!token) {
          const errorMsg = `Skipping API call due to token error for ${user.OAUTH_TOKEN_URL}`;
          console.error(errorMsg);
          await logErrorsToCSV(errorMsg);
          continue;
        }

        for (const userResult of result) {
          const requestBody = JSON.stringify(userResult, null, 2);
          console.log("Sending JSON Payload:", requestBody);

          try {
            const response = await axios.post(user.API_ENDPOINT, requestBody, {
              headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              httpsAgent: agent,
              transformRequest: [(data) => data],
              timeout: 10000,
            });
            console.log(`API Call Successful:`, response.data);
            apiResponses.push(response.data);
            await logSuccessToCSV(`API Call Successful: ${JSON.stringify(response.data)}`);
          } catch (error) {
            const errorMessage = `API Call Failed: ${
              error.response?.data || error.message
            }`;
            console.error(errorMessage);
            await logErrorsToCSV(errorMessage);
            apiResponses.push({ error: errorMessage });
          }
        }
      }
    }

        if (errors.length > 0) {
      return { errors };
    }

    // === UPDATE TABLES BEFORE CLOSING POOL ===
    let updateResult;
    try {
      updateResult = await updateTables();
      await logSuccessToCSV(`✅ Tables updated successfully`);
    } catch (updateError) {
      const msg = `Failed to update tables: ${updateError.message}`;
      await logErrorsToCSV(msg);
      updateResult = { message: msg };
    }

    return { 
      responses: apiResponses,
      updateResult 
    };
  } catch (error) {
    const errorMsg = `Error in syncDB: ${error.message}`;
    await logErrorsToCSV(errorMsg);
    throw error;
  } finally {
    if (globalPool) {
      await globalPool.close();
      console.log("Global database connection closed after syncDB");
      globalPool = null;
    }
  }
}

// Start cron job with lock
cron.schedule(
  // "26 10 * * *",
  "0 0 23,0-8 * * *", // Run hourly from 11 PM to 8 AM
  async () => {
    if (isCronRunning) {
      console.log("Cron job already running, skipping...");
      await logErrorsToCSV("Cron job skipped due to already running");
      return;
    }
    isCronRunning = true;
    try {
      console.log("⏳ Cron job started at", getSriLankaTime());
      const responses = await syncDB();

      if (Array.isArray(responses) && responses.length === 0) {
        const msg = "⚠ No response data returned from syncDB()";
        console.error(msg);
        await logErrorsToCSV(msg);
        return;
      }

      if (responses.errors) {
        console.error("❌ Errors occurred during sync:", responses.errors);
        for (const err of responses.errors) {
          await logErrorsToCSV(err);
        }
        return;
      }

      const successResponse = responses.responses?.[0];
      console.log("Cron - API Response:", successResponse);
      if (successResponse?.returnStatus === "Success") {
        console.log("✅ Database sync completed successfully.");
        await logSuccessToCSV("✅ Database sync completed successfully.");

        // const updateResult = await updateTables();
        // console.log("✅ Tables updated:", updateResult);
        // await logSuccessToCSV(`✅ Tables updated: ${JSON.stringify(updateResult)}`);
      } else {
        const msg = `⚠ Database sync had issues. Full response: ${JSON.stringify(responses)}`;
        console.error(msg);
        await logErrorsToCSV(msg);
      }
    } catch (error) {
      const msg = `❌ Cron job failed: ${error.message}`;
      console.error(msg);
      await logErrorsToCSV(msg);
    } finally {
      isCronRunning = false;
    }
  },
  {
    scheduled: true,
    timezone: "Asia/Colombo",
  }
);

// Cleanup on process exit
process.on("SIGINT", async () => {
  if (globalPool) {
    await globalPool.close();
    console.log("Global database connection closed");
  }
  process.exit(0);
});