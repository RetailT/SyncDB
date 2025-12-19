const { connectToDatabase } = require("../config/db");
const { connectToUserDatabase } = require("../config/userdb");
const cron = require("node-cron");
const axios = require("axios");
const qs = require("qs");
const fs = require("fs");
const path = require("path");
const { parse } = require("json2csv");
require("dotenv").config();
const https = require("https");

let isCronRunning = false;
const posmain = process.env.DB_DATABASE1;
const db_port1 = parseInt(process.env.DB_PORT);

const logsDir = path.join(__dirname, "../logs");

if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
  console.log("Created logs directory:", logsDir);
}
const errorLogPath = path.join(logsDir, "error_log.csv");
const successLogPath = path.join(logsDir, "success_log.csv");

async function syncDBConnection() {
  // let pool;
  try {
    const pool = await connectToDatabase();
    if (!pool || !pool.connected) {
      const msg = "Database connection failed at syncDBConnection";
      await logErrorsToCSV(msg);
      return [];
    }
    const request = pool.request();
    const query = `USE [${posmain}]; SELECT * FROM tb_SYNCDB_USERS`; // Assuming db is set in connection config

    const result = await request.query(query);

    if (result.recordset.length === 0) {
      const msg = "No customer data found in tb_SYNCDB_USERS";
      await logErrorsToCSV(msg);
      return [];
    }

    return result.recordset;
  } catch (error) {
    const errorMsg = `Error in syncDBConnection at ${process.env.DB_SERVER}:${db_port1}: ${error.message}`;
    console.error(errorMsg);
    await logErrorsToCSV(errorMsg);
    return [];
  }
}

async function userItemsDetails(ReceiptDate, ReceiptNo, connection) {
  try {
    // Create a new request object from the existing global connection or pool
    if (!connection || !connection.connected) {
      const msg = "Database connection failed at userItemsDetails";
      await logErrorsToCSV(msg);
      return [];
    }
    const request = connection.request();

    // Query only the SELECT statement (db should be set in config)
    const result = await request.query`
      SELECT Item_Desc, ItemAmt, ItemDiscountAmt 
      FROM tb_OGFITEMSALE 
      WHERE ReceiptDate = ${ReceiptDate} 
        AND ReceiptNo = ${ReceiptNo} 
        AND UPLOAD <> 'T'
    `;

    if (result.recordset.length === 0) {
      const msg = "No user item details found";
      await logErrorsToCSV(msg);
      return { error: "No user items details found" };
    }

    return result.recordset;
  } catch (error) {
    console.error("Error fetching user items details:", error);
    await logErrorsToCSV("Error fetching user items details: ", error.message);
    return { error: `Error fetching user items details: ${error.message}` };
  }
}

async function userPaymentDetails(connection) {
  try {
    if (!connection || !connection.connected) {
      const msg = "Database connection failed at userPaymentDetails";
      await logErrorsToCSV(msg);
      return [];
    }
    const request = connection.request();

    const result = await request.query`
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

    if (result.recordset.length === 0) {
      const msg = "Cannot fetch user payment details";
      await logErrorsToCSV(msg);
      return { error: "Cannot fetch user payment details" };
    }

    return result.recordset;
  } catch (error) {
    console.error("Error fetching user payment details:", error);
    await logErrorsToCSV("Error fetching user payment details", error.message);
    return { error: `Error fetching user payment details: ${error.message}` };
  }
}

async function userDetails(connection) {
  try {
    if (!connection || !connection.connected) {
      const msg = "Database connection failed at userDetails";
      await logErrorsToCSV(msg);
      return [];
    }
    const request = connection.request();

    const result = await request.query`
      SELECT 
        AppCode, PropertyCode, POSInterfaceCode, BatchCode, SalesTaxRate, OAUTH_TOKEN_URL, 
        ClientID, ClientSecret, API_ENDPOINT  
      FROM tb_OGFMAIN;
    `;

    if (result.recordset.length === 0) {
      const msg = "Cannot fetch user details";
      await logErrorsToCSV(msg);
      return;
    }

    // Trim string fields in the results
    const trimmedUserConnectionDetails = result.recordset.map((user) => {
      const trimmedUser = {};
      for (const key in user) {
        if (typeof user[key] === "string") {
          trimmedUser[key] = user[key].trim();
        } else {
          trimmedUser[key] = user[key];
        }
      }
      return trimmedUser;
    });

    return trimmedUserConnectionDetails;
  } catch (error) {
    console.error("Error fetching user connection details:", error);
    await logErrorsToCSV("Error fetching user connection details", error);
  }
}

async function getAccessToken(user) {
  try {
    const data = qs.stringify({
      client_id: user.ClientID,
      client_secret: user.ClientSecret,
      grant_type: "client_credentials",
    });

    const agent = new https.Agent({ family: 4 }); // Force IPv4

    const response = await axios.post(user.OAUTH_TOKEN_URL, data, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      httpsAgent: agent,
      timeout: 10000, // 10 seconds timeout
    });

    return response.data.access_token;
  } catch (error) {
    console.error(
      `Error fetching token from ${user.OAUTH_TOKEN_URL}:`,
      error.response ? error.response.data : error.message
    );
    await logErrorsToCSV("error fetching token", error);
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

async function updateTables(syncdbIp, syncdbPort) {

  const pool = await connectToUserDatabase(syncdbIp, syncdbPort);

  if (!pool || !pool.connected) {
    const msg = "Database connection failed at update tables";
    await logErrorsToCSV(msg);
    return res.status(500).json({ message: "Database connection failed" });
  }

  const transaction = pool.transaction();

  try {
    await transaction.begin();

    const request = transaction.request();

    const updatePayment = await request.query(`
      UPDATE tb_OGFPAYMENT
      SET UPLOAD = 'T'
      WHERE UPLOAD <> 'T' OR UPLOAD IS NULL;
    `);

    const updateItems = await request.query(`
      UPDATE tb_OGFITEMSALE
      SET UPLOAD = 'T'
      WHERE UPLOAD <> 'T' OR UPLOAD IS NULL;
    `);

    await transaction.commit();

    const paymentRows = updatePayment.rowsAffected[0];
    const itemsRows = updateItems.rowsAffected[0];

    if (paymentRows === 0 && itemsRows === 0) {
      return {
        message: "No rows were updated in tb_OGFPAYMENT or tb_OGFITEMSALE",
        paymentRowsAffected: paymentRows,
        itemsRowsAffected: itemsRows,
      };
    }
    await logSuccessToCSV("Tables updated");
    console.log("Tables updated successfully");
    return {
      message: "Tables updated successfully",
      paymentRowsAffected: paymentRows,
      itemsRowsAffected: itemsRows,
    };
  } catch (error) {
    try {
      await transaction.rollback();
    } catch (rollbackError) {
      console.error("Rollback failed:", rollbackError);
    }
    await logErrorsToCSV("Could not update tables", error.message);
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
  })
    .format(new Date())
    .replace(",", "");
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
    await connectToDatabase();

    const dbConnectionData = await syncDBConnection();

    if (!dbConnectionData || dbConnectionData.length === 0) {
      const msg = "Database connection failed at syncDB";
      await logErrorsToCSV(msg);
      return { responses: [], errors: ["No customer data found."] };
    }

    const apiResponses = [];
    const errors = [];

    for (const customer of dbConnectionData) {
      const syncdbIp = customer.IP ? customer.IP.trim() : null;
      const syncdbPort = customer.PORT ? parseInt(customer.PORT.trim()) : null;

      if (!syncdbIp) {
        const errMsg = "IP is null for a customer entry";
        errors.push(errMsg);
        await logErrorsToCSV(errMsg);
        continue;
      }
      if (!syncdbPort) {
        const errMsg = `Port is null or invalid for IP: ${syncdbIp}`;
        errors.push(errMsg);
        await logErrorsToCSV(errMsg);
        continue;
      }

      try {
        
        const connection = await connectToUserDatabase(
          customer.IP,
          customer.PORT
        );

        const users = await userDetails(connection);

        if (!users || users.length === 0) {
          const msg = `No users found for IP: ${syncdbIp}`;

          errors.push(msg);
          await logErrorsToCSV(msg);
          continue;
        }

        const payments = await userPaymentDetails(connection);

        if (payments.error) {
          errors.push(payments.error);
          continue;
        }

        // Create HTTPS agent for API calls
        const agent = new https.Agent({ family: 4 });

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
              payment.ReceiptNo,
              connection
            );

            if (items.error) {
              errors.push(items.error);
            }

            const paymentWithItems = {
              ...newPaymentDetails,
              Items: items,
            };

            userResult.PosSales.push(trimObjectStrings(paymentWithItems));
          }

          const token = await getAccessToken(user);

          if (!token) {
            const errorMsg = `Skipping API call for user ${user.AppCode} due to token error.`;
            console.error(errorMsg);
            errors.push(errorMsg);
            continue; // skip this user, move on to next
          }

          const requestBody = JSON.stringify(
            trimObjectStrings(userResult),
            null,
            2
          );

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

            apiResponses.push(response.data);
          } catch (error) {
            const errorMessage = `API Call Failed for user ${user.AppCode}: ${
              error.response?.data || error.message
            }`;
            console.error(errorMessage);
            errors.push(errorMessage);
            await logErrorsToCSV("API call failed");
            apiResponses.push({ error: errorMessage });
          }
        }
      } catch (err) {
        const errMsg = `Database Connection Error for IP ${syncdbIp}: ${err.message}`;
        console.error(errMsg);
        errors.push(errMsg);
        await logErrorsToCSV(errMsg);
      }

      try {
        await updateTables(customer.IP, customer.PORT);
      } catch (e) {
        const errMsg = `Could not update tables after sync: ${e.message}`;
        console.error(errMsg);
        errors.push(errMsg);
        await logErrorsToCSV(errMsg);
      }
    }

    return { responses: apiResponses, errors };
  } catch (error) {
    console.error("Unexpected error occurred in syncDB:", error);
    await logErrorsToCSV("Unexpected error in syncDB", error.message);
    return { responses: [], errors: [error.message] };
  }
}

// Start cron job with lock
function startSyncCron() {
  cron.schedule(
    // "*/5 * * * *", // Every 5 minutes for testing
    // "42 11 * * *", // Every day at 09:25 AM
    "0 0 23,0-8 * * *", // Your original schedule
    async () => {
      if (isCronRunning) {
        console.log("Cron job already running, skipping...");
        await logErrorsToCSV("Cron job skipped due to already running");
        return;
      }
      isCronRunning = true;
      try {
        console.log("Cron job started at", getSriLankaTime());
        const result = await syncDB();

        if (result.errors && result.errors.length > 0) {
          console.error("Sync errors:", result.errors);
          for (const err of result.errors) {
            await logErrorsToCSV(err);
          }
        } else {
          console.log("Sync completed successfully");
          await logSuccessToCSV("Database sync completed successfully");
        }
      } catch (error) {
        console.error("Cron job error:", error.message);
        await logErrorsToCSV("Cron job failed: " + error.message);
      } finally {
        isCronRunning = false;
      }
    },
    {
      scheduled: true,
      timezone: "Asia/Colombo",
    }
  );

  console.log("Cron job scheduled");
}

// === EXPORT THE STARTER ===
module.exports = {
  startSyncCron,
  // ... export other functions if used in routes
};
