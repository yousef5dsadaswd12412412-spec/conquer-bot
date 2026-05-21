require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActivityType,
} = require("discord.js");
const mysql = require("mysql2/promise");

// ==========================================
//   Validate Required Environment Variables
// ==========================================

const REQUIRED_ENV = [
  "DISCORD_TOKEN",
  "DISCORD_CHANNEL",
  "DB_HOST",
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
];

for (const key of REQUIRED_ENV) {
  if (!process.env[key]) {
    console.error(`[ERROR] Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || "10000", 10);
const SERVER_DISPLAY_NAME = process.env.SERVER_NAME || "Conquer Online";

// ==========================================
//   Discord Client Setup
// ==========================================

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

// ==========================================
//   MySQL Connection Pool
// ==========================================

let db;

async function connectDatabase() {
  try {
    db = await mysql.createPool({
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT || "3306", 10),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });

    await db.query("SELECT 1");
    console.log("[DB] Connected to MySQL successfully.");
  } catch (err) {
    console.error("[DB] Failed to connect to MySQL:", err.message);
    process.exit(1);
  }
}

// ==========================================
//   Ensure `sent` Column Exists in orders
// ==========================================

async function ensureTable() {
  await db.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS sent TINYINT(1) NOT NULL DEFAULT 0
  `).catch(async () => {
    const [cols] = await db.query(`
      SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'orders'
        AND COLUMN_NAME = 'sent'
    `);
    if (cols.length === 0) {
      await db.query(`ALTER TABLE orders ADD COLUMN sent TINYINT(1) NOT NULL DEFAULT 0`);
      console.log("[DB] Added \`sent\` column to orders table.");
    }
  });

  await db.query(`ALTER TABLE orders ADD INDEX idx_sent (sent)`).catch(() => {});
  console.log("[DB] orders table verified.");
}

// ==========================================
//   الهيكل الإجباري للطلب (نفس شكل صورة image_a9266d.png بالظبط)
// ==========================================

function buildOrderEmbed(order, state = "new") {
  const timestamp = order.created_at ? new Date(order.created_at) : new Date();
  
  // تحديد اللون: أخضر للجديد والمقبول، أحمر للمرفوض
  let color = 0x2ecc71; // الأخضر الافتراضي المريح للعين والظاهر بالصورة المثالية
  if (state === "rejected") {
    color = 0xe74c3c; // أحمر عند الرفض
  }

  // المربع النصي الرمادي العلوي حسب حالة الطلب
  let statusBoxText;
  if (state === "confirmed") {
    statusBoxText = "```\nOrder status updated.\nProcessed and confirmed successfully.\n```";
  } else if (state === "rejected") {
    statusBoxText = "```\nOrder status updated.\nOrder rejected by admin.\n```";
  } else {
    statusBoxText = "```\nNew recharge request received.\nWaiting for admin review.\n```";
  }

  // بناء الإيمبد وإجبار الخانات تطلع على شكل مربعات سفلية مصفوفة عمودياً
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle("🗺️ Travil-Conquer Recharge")
    .setDescription(statusBoxText)
    .addFields(
      {
        name: "👤 Player",
        value: order.player_name ? `\`\`\`${order.player_name}\`\`\`` : "```Unknown```",
        inline: true,
      },
      {
        name: "📌 UID",
        value: order.uid ? `\`\`\`${order.uid}\`\`\`` : "```—```",
        inline: true,
      },
      {
        name: "🔴 Package",
        value: order.title ? `\`\`\`${order.title}\`\`\`` : "```—```",
        inline: false,
      },
      {
        name: "📋 Order ID",
        value: order.order_id ? `\`\`\`${order.order_id}\`\`\`` : order.id ? `\`\`\`${order.id}\`\`\`` : "```—```",
        inline: false,
      }
    );

  // لو الطلب اتقبل أو اترفض بيظهر اسم الإداري تحت الخانات مباشرة
  if (state !== "new" && order._adminId) {
    embed.addFields({
      name: "🛡️ Handled By",
      value: `<@${order._adminId}>`,
      inline: false,
    });
  }

  // الصورة الكبيرة الثابتة بالأسفل مباشرة قبل الأزرار
  if (order.image_url && /^https?:\/\//i.test(order.image_url)) {
    embed.setImage(order.image_url);
  } else {
    // لو اللانشر مش باعت صورة، البوت بيثبت الصورة الافتراضية الأنيقة للفورمات
    embed.setImage("https://i.imgur.com/uVpZ8f7.png"); 
  }

  embed.setTimestamp(timestamp);

  return embed;
}

// ==========================================
//   Build Action Buttons
// ==========================================

function buildButtonRow(orderUniqueId) {
  const confirmBtn = new ButtonBuilder()
    .setCustomId(`confirm_${orderUniqueId}`)
    .setLabel("Confirm")
    .setEmoji("✅")
    .setStyle(ButtonStyle.Success);

  const rejectBtn = new ButtonBuilder()
    .setCustomId(`reject_${orderUniqueId}`)
    .setLabel("Reject")
    .setEmoji("❌")
    .setStyle(ButtonStyle.Danger);

  return new ActionRowBuilder().addComponents(confirmBtn, rejectBtn);
}

// ==========================================
//   Send Log to Log Channel
// ==========================================

async function sendLog(logEmbed) {
  const logChannelId = process.env.LOG_CHANNEL_ID;
  if (!logChannelId) return;
  try {
    const logChannel = await client.channels.fetch(logChannelId);
    if (logChannel && logChannel.isTextBased()) {
      await logChannel.send({ embeds: [logEmbed] });
    }
  } catch (err) {
    console.error("[LOG] Failed to send log:", err.message);
  }
}

function buildLogEmbed({ action, order, admin, color, icon, messageUrl }) {
  const now = new Date();
  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${icon}  ${action}`)
    .addFields(
      { name: "👤 Player", value: `\`${order.player_name || "Unknown"}\``, inline: true },
      { name: "📌 UID", value: `\`${order.uid || "—"}\``, inline: true },
      { name: "🔴 Package", value: order.title ? `\`${order.title}\`` : "\`—\`", inline: false },
      { name: "📋 Order ID", value: `\`${order.order_id || order.id}\``, inline: true },
      { name: "🛡️ Admin", value: admin ? `<@${admin.id}> \`(${admin.tag})\`` : "\`System\`", inline: true },
      {
        name: "📡 Source Message",
        value: messageUrl ? `**[🔗 Jump to Order Message](${messageUrl})**` : "\`—\`",
        inline: false,
      }
    )
    .setFooter({ text: `${SERVER_DISPLAY_NAME} • Log System` })
    .setTimestamp(now);
}

// ==========================================
//   Button Interaction Handler
// ==========================================

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  const { customId, user, message } = interaction;

  const confirmMatch = customId.match(/^confirm_(.+)$/);
  const rejectMatch  = customId.match(/^reject_(.+)$/);

  if (!confirmMatch && !rejectMatch) return;

  const orderUniqueId = (confirmMatch || rejectMatch)[1];
  let action, newStatus, replyText, logColor, logIcon;

  if (confirmMatch) {
    action = "Order Confirmed"; newStatus = "confirmed";
    replyText = `✅ Order has been confirmed successfully by <@${user.id}>`;
    logColor = 0x2ecc71; logIcon = "✅";
  } else {
    action = "Order Rejected"; newStatus = "rejected";
    replyText = `❌ Order has been rejected by <@${user.id}>`;
    logColor = 0xe74c3c; logIcon = "❌";
  }

  try {
    const [rows] = await db.query("SELECT * FROM orders WHERE id = ?", [orderUniqueId]);
    if (rows.length === 0) {
      await interaction.reply({ content: "⚠️ Order not found in database.", ephemeral: true });
      return;
    }

    const order = rows[0];

    await db.query("UPDATE orders SET status = ? WHERE id = ?", [newStatus, order.id]);

    const updatedOrderData = { ...order, status: newStatus, _adminId: user.id };
    const updatedEmbed = buildOrderEmbed(updatedOrderData, newStatus);

    await message.edit({ embeds: [updatedEmbed], components: [] });

    await interaction.reply({
      content: `${replyText} (Player: \`${order.player_name}\` | ID: \`${order.order_id || order.id}\`)`,
      ephemeral: false,
    });

    const logEmbed = buildLogEmbed({
      action,
      order: updatedOrderData,
      admin: user,
      color: logColor,
      icon: logIcon,
      messageUrl: message.url,
    });
    await sendLog(logEmbed);

    console.log(`[BOT] Order #${orderUniqueId} updated to [${newStatus}] by ${user.tag}`);
  } catch (err) {
    console.error(`[BOT] Error handling buttons for order #${orderUniqueId}:`, err.message);
    try {
      await interaction.reply({ content: "❌ An error occurred while updating the order status.", ephemeral: true });
    } catch (_) {}
  }
});

// ==========================================
//   Fetch & Process New Orders (Anti-Duplicate Loop)
// ==========================================

let isProcessing = false;

async function checkNewOrders() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL);

    if (!channel || !channel.isTextBased()) {
      console.error("[BOT] Configured channel is invalid or not text-based.");
      isProcessing = false;
      return;
    }

    // سحب سطر واحد فقط بكل لفة لحماية السيستم من التكرار المزدوج
    const [rows] = await db.query(
      "SELECT * FROM orders WHERE sent = 0 ORDER BY created_at ASC LIMIT 1"
    );

    if (rows.length === 0) {
      isProcessing = false;
      return;
    }

    const order = rows[0];
    const dbId = String(order.id);

    // حجز السطر فوراً داخل الداتابيز قبل بدء عملية الإرسال للديسكورد لضمان عدم سحبه مرتين
    await db.query("UPDATE orders SET sent = 1 WHERE id = ?", [order.id]);

    try {
      // إجبار البيانات المأخوذة من الداتابيز تترتب في التصميم الجديد
      const embed = buildOrderEmbed(order, "new");
      const row = buildButtonRow(dbId);

      await channel.send({ embeds: [embed], components: [row] });

      console.log(`[BOT] Order #${order.order_id || dbId} successfully formatted and sent.`);
    } catch (orderErr) {
      console.error(`[BOT] Failed to send message for order #${order.id}:`, orderErr.message);
      await db.query("UPDATE orders SET sent = 2 WHERE id = ?", [order.id]).catch(() => {});
    }
  } catch (err) {
    console.error("[BOT] Error inside checkNewOrders loop:", err.message);
  } finally {
    isProcessing = false;
  }
}

// ==========================================
//   Bot Ready Event
// ==========================================

let isWatching = false;

client.once("ready", async () => {
  console.log(`[BOT] Logged in as ${client.user.tag}`);

  client.user.setActivity(`${SERVER_DISPLAY_NAME} | Orders`, {
    type: ActivityType.Watching,
  });

  // تشغيل التايمر الآمن لعدم تداخل المهام البرمجية
  if (!isWatching) {
    isWatching = true;
    console.log(`[BOT] Securely scanning database every ${POLL_INTERVAL / 1000}s...`);
    await checkNewOrders();
    setInterval(checkNewOrders, POLL_INTERVAL);
  }
});

// ==========================================
//   Graceful Shutdown
// ==========================================

async function shutdown(signal) {
  console.log(`\n[BOT] ${signal} trigger. Disconnecting...`);
  client.destroy();
  if (db) await db.end();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  console.error("[ERROR] Unhandled Rejection:", reason);
});

// ==========================================
//   Initialization
// ==========================================

(async () => {
  console.log("========================================");
  console.log("   Conquer Online — Fixed Layout Bot    ");
  console.log("========================================");

  await connectDatabase();
  await ensureTable();
  await client.login(process.env.DISCORD_TOKEN);
})();