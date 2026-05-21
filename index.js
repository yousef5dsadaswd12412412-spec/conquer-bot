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
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // مهم جداً عشان البوت يلقط رسالة اللانشر أول ما تنزل
  ],
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
//   Ensure Table Structure
// ==========================================

async function ensureTable() {
  await db.query(`
    ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS sent TINYINT(1) NOT NULL DEFAULT 0
  `).catch(() => {});
  console.log("[DB] orders table verified.");
}

// ==========================================
//   دالة تحويل الطلب لتصميم المربعات النظيف الموحد
// ==========================================

function buildOrderEmbed(order, state = "new") {
  const timestamp = order.created_at ? new Date(order.created_at) : new Date();
  
  let color = 0x2ecc71; // أخضر افتراضي للطلب الجديد والمقبول
  if (state === "rejected") {
    color = 0xe74c3c; // أحمر عند الرفض
  }

  let statusBoxText;
  if (state === "confirmed") {
    statusBoxText = "```\nOrder status updated.\nProcessed and confirmed successfully.\n```";
  } else if (state === "rejected") {
    statusBoxText = "```\nOrder status updated.\nOrder rejected by admin.\n```";
  } else {
    statusBoxText = "```\nNew recharge request received.\nWaiting for admin review.\n```";
  }

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle("🚨 Travil-Conquer Recharge")
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

  if (state !== "new" && order._adminId) {
    embed.addFields({
      name: "🛡️ Handled By",
      value: `<@${order._adminId}>`,
      inline: false,
    });
  }

  // الحفاظ على الصورة الكبيرة الأساسية بتاعة اللانشر زي ما هي بدون تخريب
  if (order.image_url && /^https?:\/\//i.test(order.image_url)) {
    embed.setImage(order.image_url);
  } else {
    embed.setImage("https://i.imgur.com/uVpZ8f7.png"); 
  }

  embed.setTimestamp(timestamp);
  return embed;
}

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
//   نظام مراقبة الشات والتقاط رسائل اللانشر
// ==========================================

client.on("messageCreate", async (message) => {
  // فحص لو الرسالة جاية في الروم المخصصة للأوردرات ومن ويب هوك أو بوت اللانشر
  if (message.channel.id !== process.env.DISCORD_CHANNEL) return;
  if (message.author.id === client.user.id) return; // تجاهل رسائل البوت نفسه

  try {
    // الانتظار ثانيتين للتأكد من تسجيل الطلب في القاعدة
    setTimeout(async () => {
      // سحب آخر طلب لم يتم إرساله وزرعه بالزراير بعد
      const [rows] = await db.query(
        "SELECT * FROM orders WHERE sent = 0 ORDER BY created_at DESC LIMIT 1"
      );

      if (rows.length > 0) {
        const order = rows[0];
        const dbId = String(order.id);

        // حجز الطلب في القاعدة
        await db.query("UPDATE orders SET sent = 1 WHERE id = ?", [order.id]);

        // مسح الرسالة القديمة (الغير منسقة) اللي نزلت من اللانشر منعاً للتكرار
        if (message.deletable) {
          await message.delete().catch(() => {});
        }

        // إرسال التصميم الاحترافي المتناسق مع الزراير فوراً مكانها
        const embed = buildOrderEmbed(order, "new");
        const row = buildButtonRow(dbId);

        await message.channel.send({ embeds: [embed], components: [row] });
        console.log(`[BOT] Captured launcher order #${order.order_id || dbId} and replaced layout successfully.`);
      }
    }, 2000);
  } catch (err) {
    console.error("[BOT] Error in message capturing loop:", err.message);
  }
});

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

    console.log(`[BOT] Order #${orderUniqueId} completed by ${user.tag}`);
  } catch (err) {
    console.error(`[BOT] Error updating button status:`, err.message);
  }
});

// ==========================================
//   Bot Ready Event
// ==========================================

client.once("ready", async () => {
  console.log(`[BOT] Logged in as ${client.user.tag}`);
  client.user.setActivity(`${SERVER_DISPLAY_NAME} | Live Orders`, {
    type: ActivityType.Watching,
  });
  console.log("[BOT] System online. Waiting for launcher messages to format...");
});

// ==========================================
//   Initialization
// ==========================================

(async () => {
  await connectDatabase();
  await ensureTable();
  await client.login(process.env.DISCORD_TOKEN);
})();