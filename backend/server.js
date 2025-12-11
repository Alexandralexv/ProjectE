require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");

const app = express();

// Подключение к БД
const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
});

// CORS
app.use(
  cors({
    origin: "*",
  })
);

// JSON парсер
app.use(express.json());

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====

// Создание JWT токена
function generateToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role,
    },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "1d" }
  );
}

// Мидлвар для проверки токена
function authMiddleware(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) {
    return res.status(401).json({ error: "Требуется авторизация" });
  }

  const [type, token] = authHeader.split(" ");
  if (type !== "Bearer" || !token) {
    return res.status(401).json({ error: "Неверный формат токена" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload;
    next();
  } catch (err) {
    console.error("Ошибка проверки токена:", err);
    return res.status(401).json({ error: "Неверный или истекший токен" });
  }
}

function adminOnlyMiddleware(req, res, next) {
  if (!req.user || req.user.role !== "ADMIN") {
    return res.status(403).json({ error: "Доступ только для администратора" });
  }
  next();
}

app.get("/stats/mv", authMiddleware, adminOnlyMiddleware, async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query("SELECT * FROM order_stats_mv");
      return res.json(result.rows);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Ошибка выборки витрины:", err);
    return res.status(500).json({ error: "Ошибка сервера" });
  }
});

// ===== ПРОСТО ПРОВЕРКА, ЧТО СЕРВЕР ЖИВ =====
app.get("/", (req, res) => {
  res.send("Metalworking backend is running");
});

// ===== ПУБЛИЧНАЯ ФОРМА: СОЗДАНИЕ ЗАКАЗА =====
app.post("/send", async (req, res) => {
  try {
    const { name, tel, email, services, message } = req.body;

    if (!name || !tel) {
      return res.status(400).json({ error: "Имя и телефон обязательны" });
    }

    const servicesStr = Array.isArray(services)
      ? services.join(", ")
      : String(services || "");

    const client = await pool.connect();
    try {
      const query = `
        INSERT INTO orders (customer_name, customer_phone, customer_email, services, message)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, created_at
      `;
      const values = [name, tel, email || null, servicesStr, message || null];

      const result = await client.query(query, values);
      const order = result.rows[0];

      console.log("Создан заказ:", order);

      return res.status(201).json({
        success: true,
        orderId: order.id,
        createdAt: order.created_at,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Ошибка при сохранении заказа:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

// ===== АВТОРИЗАЦИЯ (LOGIN) =====
app.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res
        .status(400)
        .json({ error: "Необходимо указать логин и пароль" });
    }

    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT * FROM users WHERE username = $1",
        [username]
      );
      if (result.rows.length === 0) {
        return res.status(401).json({ error: "Неверный логин или пароль" });
      }

      const user = result.rows[0];

      const passwordOk = await bcrypt.compare(password, user.password_hash);

      if (!passwordOk) {
        return res.status(401).json({ error: "Неверный логин или пароль" });
      }

      const token = generateToken(user);

      return res.json({
        token,
        username: user.username,
        role: user.role,
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Ошибка при логине:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

// Получение списка пользователей (только для админа)
app.get("/users", authMiddleware, adminOnlyMiddleware, async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT id, username, full_name, role, created_at
         FROM users
         ORDER BY created_at DESC`
      );
      return res.json(result.rows);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Ошибка при получении пользователей:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

// Создание нового пользователя (только для админа)
app.post("/users", authMiddleware, adminOnlyMiddleware, async (req, res) => {
  try {
    const { username, password, full_name, role } = req.body;

    if (!username || !password) {
      return res
        .status(400)
        .json({ error: "Необходимо указать логин и пароль" });
    }

    const userRole = role === "ADMIN" ? "ADMIN" : "MANAGER";

    const passwordHash = await bcrypt.hash(password, 10);

    const client = await pool.connect();
    try {
      const result = await client.query(
        `INSERT INTO users (username, password_hash, full_name, role)
         VALUES ($1, $2, $3, $4)
         RETURNING id, username, full_name, role, created_at`,
        [username, passwordHash, full_name || null, userRole]
      );

      return res.status(201).json(result.rows[0]);
    } finally {
      client.release();
    }
  } catch (err) {
    if (err.code === "23505") {
      // unique_violation (username)
      return res.status(400).json({ error: "Такой логин уже существует" });
    }
    console.error("Ошибка при создании пользователя:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

// Удаление пользователя (только для админа)
app.delete(
  "/users/:id",
  authMiddleware,
  adminOnlyMiddleware,
  async (req, res) => {
    try {
      const userId = parseInt(req.params.id, 10);

      // запрещаем удалять самого себя, чтобы случайно не остаться без админа
      if (userId === req.user.id) {
        return res
          .status(400)
          .json({ error: "Нельзя удалить самого себя (текущего админа)" });
      }

      const client = await pool.connect();
      try {
        const result = await client.query(
          "DELETE FROM users WHERE id = $1 RETURNING id",
          [userId]
        );

        if (result.rows.length === 0) {
          return res.status(404).json({ error: "Пользователь не найден" });
        }

        return res.json({ success: true });
      } finally {
        client.release();
      }
    } catch (err) {
      console.error("Ошибка при удалении пользователя:", err);
      return res.status(500).json({ error: "Внутренняя ошибка сервера" });
    }
  }
);

// ===== ЗАКАЗЫ ДЛЯ МЕНЕДЖЕРА (ЗАЩИЩЁННЫЕ МАРШРУТЫ) =====

// Получение списка заказов
app.get("/orders", authMiddleware, async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      const { q, status, sort, direction } = req.query;

      // --- ФИЛЬТРЫ ---
      const whereClauses = [];
      const values = [];
      let paramIndex = 1;

      if (
        status &&
        ["NEW", "IN_PROGRESS", "DONE", "CANCELED"].includes(status)
      ) {
        whereClauses.push(`status = $${paramIndex++}`);
        values.push(status);
      }

      if (q && q.trim() !== "") {
        const like = `%${q.trim()}%`;
        whereClauses.push(
          `(customer_name ILIKE $${paramIndex} OR
            customer_phone ILIKE $${paramIndex} OR
            customer_email ILIKE $${paramIndex} OR
            services ILIKE $${paramIndex} OR
            message ILIKE $${paramIndex})`
        );
        values.push(like);
        paramIndex++;
      }

      let whereSql = "";
      if (whereClauses.length > 0) {
        whereSql = "WHERE " + whereClauses.join(" AND ");
      }

      // --- СОРТИРОВКА ---
      const allowedSortFields = {
        created_at: "created_at",
        customer_name: "customer_name",
        status: "status",
      };

      const sortField = allowedSortFields[sort] || "created_at";
      const sortDirection =
        direction && direction.toLowerCase() === "asc" ? "ASC" : "DESC";

      const query = `
        SELECT id, customer_name, customer_phone, customer_email, services,
               message, status, created_at
        FROM orders
        ${whereSql}
        ORDER BY ${sortField} ${sortDirection}
      `;

      const result = await client.query(query, values);
      return res.json(result.rows);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Ошибка при получении заказов:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

// Обновление статуса заказа
app.patch("/orders/:id/status", authMiddleware, async (req, res) => {
  try {
    const orderId = req.params.id;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({ error: "Необходимо указать статус" });
    }

    const client = await pool.connect();
    try {
      const result = await client.query(
        `UPDATE orders
         SET status = $1, updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [status, orderId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Заказ не найден" });
      }

      return res.json(result.rows[0]);
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Ошибка при обновлении статуса заказа:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

// Удаление заказа
app.delete("/orders/:id", authMiddleware, async (req, res) => {
  try {
    const orderId = req.params.id;

    const client = await pool.connect();
    try {
      const result = await client.query(
        "DELETE FROM orders WHERE id = $1 RETURNING id",
        [orderId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Заказ не найден" });
      }

      return res.json({ success: true });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Ошибка при удалении заказа:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

// ===== СТАТИСТИКА (ЗАЩИЩЁННЫЙ МАРШРУТ) =====
app.get("/stats", authMiddleware, async (req, res) => {
  try {
    const client = await pool.connect();
    try {
      // 1) Заказы и распределение по статусам
      const ordersStatsResult = await client.query(`
        SELECT
          COUNT(*) AS total_orders,
          SUM(CASE WHEN status = 'NEW' THEN 1 ELSE 0 END) AS new_orders,
          SUM(CASE WHEN status = 'IN_PROGRESS' THEN 1 ELSE 0 END) AS in_progress_orders,
          SUM(CASE WHEN status = 'DONE' THEN 1 ELSE 0 END) AS done_orders,
          SUM(CASE WHEN status = 'CANCELED' THEN 1 ELSE 0 END) AS canceled_orders
        FROM orders
      `);

      const ordersStats = ordersStatsResult.rows[0];

      // 2) Количество пользователей
      const usersCountResult = await client.query(`
        SELECT COUNT(*) AS total_users FROM users
      `);
      const usersStats = usersCountResult.rows[0];

      // 3) Среднее время выполнения (для DONE, разница между updated_at и created_at)
      const avgTimeResult = await client.query(`
        SELECT
          AVG(EXTRACT(EPOCH FROM (updated_at - created_at))) AS avg_seconds
        FROM orders
        WHERE status = 'DONE'
          AND updated_at IS NOT NULL
      `);
      const avgSeconds = avgTimeResult.rows[0].avg_seconds;

      let avgHours = null;
      if (avgSeconds !== null) {
        avgHours = avgSeconds / 3600; // в часах
      }

      return res.json({
        totalOrders: Number(ordersStats.total_orders),
        statusCounts: {
          NEW: Number(ordersStats.new_orders),
          IN_PROGRESS: Number(ordersStats.in_progress_orders),
          DONE: Number(ordersStats.done_orders),
          CANCELED: Number(ordersStats.canceled_orders),
        },
        totalUsers: Number(usersStats.total_users),
        avgCompletionHours: avgHours, // может быть null, если ещё нет завершённых заказов
      });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Ошибка при получении статистики:", err);
    return res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

// ===== ЗАПУСК СЕРВЕРА =====
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
