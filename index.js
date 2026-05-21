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
const SERVER_DISPLAY_NAME = process.env.SERVER_NAME || "Travil-Conquer Recharge";

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
      console.log("[DB] Added `sent` column to orders table.");
    }
  });

  await db.query(`ALTER TABLE orders ADD INDEX idx_sent (sent)`).catch(() => {});
  console.log("[DB] orders table verified.");
}

// ==========================================
//   Parse Embed Color
// ==========================================

function parseColor(colorStr) {
  if (!colorStr) return 0x00ffcc; 
  const hex = colorStr.replace("#", "").trim();
  const parsed = parseInt(hex, 16);
  return isNaN(parsed) ? 0x00ffcc : parsed;
}

// ==========================================
//   Build Professional Discord Embed 
// ==========================================

function buildOrderEmbed(order, state = "new") {
  const serverName = order.server_name || SERVER_DISPLAY_NAME;

  let color, embedTitle;
  if (state === "confirmed") {
    color = 0x2ecc71;
    embedTitle = "✅  Order Confirmed";
  } else if (state === "rejected") {
    color = 0xe74c3c;
    embedTitle = "🚫  Order Rejected";
  } else {
    color = parseColor(order.embed_color);
    embedTitle = `🗄️  ${serverName}`;
  }

  // تم تظبيط الـ الرموز لضمان ظهور الصناديق كاملة بدون أي مشاكل أو اختفاء
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(embedTitle)
    .setDescription("```\nNew recharge request received.\nWaiting for admin review.\n```")
    .addFields(
      {
        name: "👤 Player",
        value: order.player_name ? `\`\`\`${order.player_name}\`\`\`` : "```Unknown```",
        inline: false,
      },
      {
        name: "#️⃣ UID",
        value: order.uid ? `\`\`\`${order.uid}\`\`\`` : "```—```",
        inline: false,
      },
      {
        name: "🔴 Package",
        value: order.title ? `\`\`\`${order.title}\`\`\`` : "```(No title)```",
        inline: false,
      },
      {
        name: "📄 Order ID",
        value: order.order_id ? `\`\`\`${order.order_id}\`\`\`` : order.id ? `\`\`\`${order.id}\`\`\`` : "```—```",
        inline: false,
      }
    );

  if (order.description) {
    embed.addFields({
      name: "📝 Description",
      value: `\`\`\`${order.description}\`\`\``.slice(0, 1024),
      inline: false,
    });
  }

  if (order.image_url && /^https?:\/\//i.test(order.image_url)) {
    embed.setImage(order.image_url);
  }

  return embed;
}

// ==========================================
//   Build 2-Button Row (Confirm / Reject)
// ==========================================

function buildButtonRow(orderUniqueId) {
  const confirmBtn = new ButtonBuilder()
    .setCustomId(`confirm_${orderUniqueId}`)
    .setLabel("Confirm")
    .setStyle(ButtonStyle.Success);

  const rejectBtn = new ButtonBuilder()
    .setCustomId(`reject_${orderUniqueId}`)
    .setLabel("Reject")
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
      {
        name: "👤  Player",
        value: `\`${order.player_name || "Unknown"}\``,
        inline: true,
      },
      {
        name: "🔑  UID",
        value: `\`${order.uid || "—"}\``,
        inline: true,
      },
      {
        name: "🖥️  Server",
        value: `\`${order.server_name || SERVER_DISPLAY_NAME}\``,
        inline: true,
      },
      {
        name: "📦  Package",
        value: order.title ? `\`${order.title}\`` : "`—`",
        inline: true,
      },
      {
        name: "🆔  Order ID",
        value: `\`${order.order_id || order.id}\``,
        inline: true,
      },
      {
        name: "🛡️  Admin",
        value: admin ? `<@${admin.id}> \`(${admin.tag})\`` : "`System`",
        inline: true,
      },
      {
        name: "📝  Description",
        value: order.description ? `> ${order.description}`.slice(0, 512) : "> —",
        inline: false,
      },
      {
        name: "📡  Received From",
        value: messageUrl
          ? `**Channel:** <#${order._channelId || "—"}>  \`${order._channelName || "—"}\`\n**Server:** \`${order._guildName || "—"}\`\n**[🔗 Jump to Message](${messageUrl})**`
          : "`—`",
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
    replyText = `✅ Order confirmed by <@${user.id}>`;
    logColor = 0x2ecc71; logIcon = "✅";
  } else {
    action = "Order Rejected"; newStatus = "rejected";
    replyText = `🚫 Order rejected by <@${user.id}>`;
    logColor = 0xe74c3c; logIcon = "🚫";
  }

  try {
    const [rows] = await db.query("SELECT * FROM orders WHERE id = ?", [orderUniqueId]);
    if (rows.length === 0) {
      await interaction.reply({ content: "⚠️ Order not found.", ephemeral: true });
      return;
    }

    const order = rows[0];

    await db.query("UPDATE orders SET status = ? WHERE id = ?", [newStatus, order.id]);

    const updatedEmbed = buildOrderEmbed({ ...order, status: newStatus }, newStatus);
    await message.edit({ embeds: [updatedEmbed], components: [] });

    await interaction.reply({
      content: `${replyText} — Player: \`${order.player_name}\` | OrderID: \`${order.order_id || orderUniqueId}\``,
      ephemeral: false,
    });

    const enrichedOrder = {
      ...order,
      _channelId:   message.channel?.id   || "—",
      _channelName: message.channel?.name || "—",
      _guildName:   message.guild?.name   || "—",
    };
    const logEmbed = buildLogEmbed({
      action,
      order: enrichedOrder,
      admin: user,
      color: logColor,
      icon: logIcon,
      messageUrl: message.url,
    });
    await sendLog(logEmbed);

    console.log(`[BOT] Order #${orderUniqueId} → ${newStatus} by ${user.tag}`);
  } catch (err) {
    console.error(`[BOT] Error processing order #${orderUniqueId}:`, err.message);

    const errEmbed = new EmbedBuilder()
      .setColor(0xff0000)
      .setTitle("🚨  Bot Error")
      .addFields(
        { name: "❌  Error",     value: `\`\`\`${err.message}\`\`\``, inline: false },
        { name: "🆔  Order ID",  value: `\`${orderUniqueId}\``,        inline: true  },
        { name: "🛡️  Admin",    value: `<@${user.id}> \`(${user.tag})\``, inline: true },
        { name: "🎯  Action",    value: `\`${customId}\``,              inline: true  }
      )
      .setFooter({ text: `${SERVER_DISPLAY_NAME} • Error Log` })
      .setTimestamp();
    await sendLog(errEmbed);

    try {
      await interaction.reply({ content: "❌ Something went wrong. Check the log channel.", flags: 64 });
    } catch (_) {}
  }
});

// ==========================================
//   Fetch & Process New Orders
// ==========================================

let isProcessing = false;

async function checkNewOrders() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL);

    if (!channel || !channel.isTextBased()) {
      console.error("[BOT] Discord channel not found or is not a text channel.");
      isProcessing = false;
      return;
    }

    const [rows] = await db.query(
      "SELECT * FROM orders WHERE sent = 0 ORDER BY created_at ASC LIMIT 10"
    );

    if (rows.length === 0) {
      isProcessing = false;
      return;
    }

    console.log(`[BOT] Found ${rows.length} new order(s) to process.`);

    for (const order of rows) {
      try {
        const dbId = String(order.id);

        const embed = buildOrderEmbed(order);
        const row = buildButtonRow(dbId);

        await channel.send({ embeds: [embed], components: [row] });
        await db.query("UPDATE orders SET sent = 1 WHERE id = ?", [order.id]);

        console.log(
          `[BOT] Order #${order.order_id || dbId} — Player: ${order.player_name} — "${order.title}" → Sent & marked.`
        );
      } catch (orderErr) {
        const errDetail = orderErr.rawError
          ? JSON.stringify(orderErr.rawError)
          : orderErr.errors
          ? JSON.stringify(orderErr.errors)
          : orderErr.message;

        console.error(`[BOT] Full error for order #${order.id}:`, errDetail);

        const errEmbed = new EmbedBuilder()
          .setColor(0xff0000)
          .setTitle("🚨  Send Error")
          .addFields(
            { name: "❌  Error",    value: `\`\`\`${errDetail.slice(0, 900)}\`\`\``, inline: false },
            { name: "🆔  Order ID", value: `\`${String(order.order_id || order.id).slice(0, 100)}\``, inline: true },
            { name: "👤  Player",   value: `\`${order.player_name || "—"}\``,   inline: true },
            { name: "🖥️  Server",  value: `\`${order.server_name || "—"}\``,   inline: true }
          )
          .setFooter({ text: `${SERVER_DISPLAY_NAME} • Error Log` })
          .setTimestamp();
        await sendLog(errEmbed);

        await db.query("UPDATE orders SET sent = 2 WHERE id = ?", [order.id]).catch(() => {});
      }
    }
  } catch (err) {
    console.error("[BOT] Error in checkNewOrders:", err.message);
  } finally {
    isProcessing = false;
  }
}

// ==========================================
//   Bot Ready Event
// ==========================================

client.once("ready", async () => {
  console.log(`[BOT] Logged in as ${client.user.tag}`);
  console.log(`[BOT] Watching orders table every ${POLL_INTERVAL / 1000}s...`);

  client.user.setActivity(`${SERVER_DISPLAY_NAME} | Orders`, {
    type: ActivityType.Watching,
  });

  await checkNewOrders();
  setInterval(checkNewOrders, POLL_INTERVAL);
});

// ==========================================
//   Graceful Shutdown
// ==========================================

async function shutdown(signal) {
  console.log(`\n[BOT] ${signal} received. Shutting down gracefully...`);
  client.destroy();
  if (db) await db.end();
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  console.error("[ERROR] Unhandled Promise Rejection:", reason);
});

// ==========================================
//   Start Bot
// ==========================================

(async () => {
  console.log("========================================");
  console.log("   Conquer Online — Discord Order Bot  ");
  console.log("========================================");

  await connectDatabase();
  await ensureTable();
  await client.login(process.env.DISCORD_TOKEN);
})();