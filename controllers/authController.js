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
const { INSERT } = require("sequelize/lib/query-types");
const agent = new https.Agent({ family: 4 });

const JWT_SECRET = process.env.JWT_SECRET;
let IP;
let PORT;
let CUSTOMER_ID;

const logsDir = path.join(__dirname, "../logs");
const errorLogPath = path.join(logsDir, "error_log.csv");
const successLogPath = path.join(logsDir, "success_log.csv");

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

async function syncDBConnection() {
  try {
    const request = new mssql.Request(); // Initialize a new request object
    const dbConnectionResult = await request.query(
      "USE [RTPOS_MAIN] SELECT * FROM tb_SYNCDB_USERS"
    );
    if (dbConnectionResult.recordset.length === 0) {
      console.log("Cannot fetch user details");
      return;
    } else {
      const dbConnectionData = dbConnectionResult.recordset;
      return dbConnectionData;
    }
  } catch (error) {
    console.error("Error in syncDB:", error);
  }
}

async function userItemsDetails(ReceiptDate, ReceiptNo) {
  try {
    const userItemsDetails = await mssql.query`
    USE [RT_WEB]
      SELECT Item_Desc, ItemAmt, ItemDiscountAmt FROM tb_OGFITEMSALE WHERE ReceiptDate = ${ReceiptDate} AND ReceiptNo = ${ReceiptNo} AND UPLOAD <> 'T';
    `;
    if (userItemsDetails.recordset.length === 0) {
      console.log("Cannot fetch user items details");
      return { error: "Cannot fetch user items details" };
    } else {
      const userItems = userItemsDetails.recordset;
      return userItems;
    }
  } catch (error) {
    console.error("Error in fetching user items details:", error);
    return { error: `Error in fetching user items details: ${error.message}` };
  }
}

async function userPaymentDetails() {
  try {
    const userPaymentDetails = await mssql.query`
    USE [RT_WEB]
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
    if (userPaymentDetails.recordset.length === 0) {
      console.log("Cannot fetch user payment details");
      return { error: "Cannot fetch user payment details" };
    } else {
      const userConnectionDetails = userPaymentDetails.recordset;
      return userConnectionDetails;
    }
  } catch (error) {
    console.error("Error in fetching user payment details:", error);
    return {
      error: `Error in fetching user payment details: ${error.message}`,
    };
  }
}

async function userDetails() {
  try {
    const userDetails = await mssql.query`
    USE [RT_WEB]
      SELECT AppCode, PropertyCode, POSInterfaceCode, BatchCode, SalesTaxRate, OAUTH_TOKEN_URL, 
      ClientID, ClientSecret, API_ENDPOINT  FROM tb_OGFMAIN;
    `;
    if (userDetails.recordset.length === 0) {
      console.log("Cannot fetch user details");
      return;
    } else {
      const userConnectionDetails = userDetails.recordset;
      const trimmedUserConnectionDetails = userConnectionDetails.map((user) => {
        let trimmedUser = {};

        for (const key in user) {
          if (typeof user[key] === "string") {
            trimmedUser[key] = user[key].trim(); // Trim only if the value is a string
          } else {
            trimmedUser[key] = user[key]; // Keep non-string values unchanged
          }
        }

        return trimmedUser;
      });

      return trimmedUserConnectionDetails;
    }
  } catch (error) {
    console.error("Error in fetching user connection details:", error);
  }
}

// Function to get OAuth2 token for a customer
async function getAccessToken(user) {
  try {
    const data = qs.stringify({
      client_id: user.ClientID,
      client_secret: user.ClientSecret,
      grant_type: "client_credentials",
    });

    const agent = new https.Agent({
      family: 4, // force IPv4
    });

    const response = await axios.post(user.OAUTH_TOKEN_URL, data, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      httpsAgent: agent,
      timeout: 10000, // optional: set a timeout in ms (10s)
    });

    return response.data.access_token;
  } catch (error) {
    console.error(
      `Error fetching token for ${user.OAUTH_TOKEN_URL}:`,
      error.response ? error.response.data : error.message
    );
    return null;
  }
}

// Function to trim all string fields in an object recursively
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
    const updatePayment = await mssql.query`
      USE [RT_WEB]
      UPDATE tb_OGFPAYMENT
      SET UPLOAD = 'T'
      WHERE UPLOAD <> 'T' OR UPLOAD IS NULL;`;

    const updateItems = await mssql.query`
      USE [RT_WEB]
      UPDATE tb_OGFITEMSALE
      SET UPLOAD = 'T'
      WHERE UPLOAD <> 'T' OR UPLOAD IS NULL;`;

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
    return {
      message: "Could not update tables",
      error: error.message,
    };
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

// Error logger
async function logErrorsToCSV(errorMessage) {
  const errorData = {
    message: errorMessage,
    date_time: getSriLankaTime(),
  };

  const headersNeeded = !fs.existsSync(errorLogPath);
  const csv = parse([errorData], { header: headersNeeded });

  fs.appendFileSync(errorLogPath, csv + "\n", "utf8");
}

// Success logger
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

    if (!dbConnectionData || dbConnectionData.length === 0) {
      console.log("No customer data found.");
      return [];
    }

    const apiResponses = [];
    const errors = [];

    for (const customer of dbConnectionData) {
      syncdbIp = customer.IP ? customer.IP.trim() : null;
      syncdbPort = customer.PORT ? parseInt(customer.PORT.trim()) : null;

      if (!syncdbIp) {
        console.log("IP is null");
        errors.push("IP is null");
      }
      if (!syncdbPort) {
        console.log("Port is null");
        errors.push("Port is null");
      }

      try {
        await mssql.close();
        const syncdbConfig = {
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          server: syncdbIp,
          database: process.env.DB_DATABASE2,
          options: {
            encrypt: false,
            trustServerCertificate: true,
          },
          port: syncdbPort,
        };

        await mssql.connect(syncdbConfig);
        console.log("Successfully connected to the sync database");

        const users = await userDetails();
        const payments = await userPaymentDetails();

        if (payments.error) {
          errors.push(payments.error);
          logErrorsToCSV(payments.error);
        }

        const result = [];

        for (const user of users) {
          const {
            SalesTaxRate,
            OAUTH_TOKEN_URL,
            API_ENDPOINT,
            ...filteredUser
          } = user;

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

            const formattedTime = new Date(
              payment.ReceiptTime
            ).toLocaleTimeString("en-GB", { hour12: false });

            const newPaymentDetails = {
              PropertyCode: filteredUser.PropertyCode,
              POSInterfaceCode: filteredUser.POSInterfaceCode,
              ...filteredPayment,
              ReceiptDate: formattedDate,
              ReceiptTime: formattedTime,
            };

            const items = await userItemsDetails(
              payment.ReceiptDate,
              payment.ReceiptNo
            );
            if (items.error) {
              errors.push(items.error);
              logErrorsToCSV(items.error);
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
            const errorMsg = `Skipping API call due to token error.`;
            console.error(errorMsg);
            logErrorsToCSV(errorMsg);
            return [];
          }

          for (const userResult of result) {
            const requestBody = JSON.stringify(userResult, null, 2);
            console.log("Sending JSON Payload:", requestBody);

            try {
              const response = await axios.post(
                user.API_ENDPOINT,
                requestBody,
                {
                  headers: {
                    Authorization: `Bearer ${token}`,
                    "Content-Type": "application/json",
                    Accept: "application/json",
                  },
                  httpsAgent: agent,
                  transformRequest: [(data) => data],
                  timeout: 10000,
                }
              );

              console.log(`API Call Successful:`, response.data);
              apiResponses.push(response.data);
              logSuccessToCSV(
                `API Call Successful: ${JSON.stringify(response.data)}`
              );
            } catch (error) {
              const errorMessage = `API Call Failed: ${
                error.response?.data || error.message
              }`;
              console.error(errorMessage);

              // Log errors correctly
              logErrorsToCSV(errorMessage);

              apiResponses.push({ error: errorMessage });
            }
          }
        }
      } catch (err) {
        console.error("Database Connection Error:", err);
        logErrorsToCSV(`Database Connection Error: ${err.message}`);
        errors.push(err.message);
      }
    }

    if (errors.length > 0) {
      return { errors };
    }

    return { responses: apiResponses };
  } catch (error) {
    console.log("Error occurred:", error);
    logErrorsToCSV(error.message);

    throw error;
  }
}

// Schedule the job to run every day
cron.schedule(
  // "8 9 * * *",
  "0 0 23,0-8 * * *", // Run hourly from 11 PM to 8 AM
  async () => {
    try {
      console.log("⏳ Cron job started at", getSriLankaTime());
      const responses = await syncDB();

      if (Array.isArray(responses) && responses.length === 0) {
        const msg = "⚠ No response data returned from syncDB()";
        console.error(msg);
        await logErrorsToCSV(msg);
        // return;
      }

      if (responses.errors) {
        console.error("❌ Errors occurred during sync:", responses.errors);
        for (const err of responses.errors) {
          await logErrorsToCSV(err);
        }
        return;
      }

      const successResponse = responses.responses?.[0];
      if (successResponse?.returnStatus === "Success") {
        console.log("✅ Database sync completed successfully.");
        await logSuccessToCSV("✅ Database sync completed successfully.");

        try {
          const updateResult = await updateTables();
          console.log("✅ Tables updated:", updateResult);
          await logSuccessToCSV(`✅ Tables updated: ${JSON.stringify(updateResult)}`);
        } catch (updateError) {
          const errMsg = `❌ Error updating tables: ${updateError.message}`;
          console.error(errMsg);
          await logErrorsToCSV(errMsg);
        }
      } else {
        const msg = "⚠ Database sync had issues. Full response: " + JSON.stringify(responses);
        console.error(msg);
        await logErrorsToCSV(msg);
      }
    } catch (error) {
      const msg = "❌ Cron job failed: " + error.message;
      console.error(msg);
      await logErrorsToCSV(msg);
    }
  },
  {
    scheduled: true,
    timezone: "Asia/Colombo",
  }
);
