-- ============================================================
-- queries.sql — примеры запросов к системе управления заказами
-- ============================================================

-- Q1. Список заказов с клиентом, приоритетом и сроком
SELECT
  o.id,
  c.name AS customer,
  o.status,
  o.priority,
  o.due_date,
  o.created_at,
  o.updated_at
FROM orders o
JOIN customers c ON c.id = o.customer_id
ORDER BY o.id;

-- Q2. Состав заказа: какие изделия, материал, количество
SELECT
  o.id AS order_id,
  p.name AS product,
  m.name AS material,
  oi.quantity,
  oi.notes
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
JOIN products p ON p.id = oi.product_id
LEFT JOIN materials m ON m.id = oi.material_id
ORDER BY o.id, oi.id;

-- Q3. Технологический маршрут (производственная цепочка) по заказу
SELECT
  o.id AS order_id,
  oi.id AS item_id,
  p.name AS product,
  rs.step_no,
  op.name AS operation,
  w.name AS workshop,
  rs.status AS step_status,
  rs.planned_minutes,
  rs.planned_start,
  rs.planned_finish
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
JOIN products p ON p.id = oi.product_id
JOIN route_steps rs ON rs.order_item_id = oi.id
JOIN operations op ON op.id = rs.operation_id
LEFT JOIN workshops w ON w.id = rs.workshop_id
ORDER BY o.id, oi.id, rs.step_no;

-- Q4. Факт выполнения операций: на каком оборудовании и кем выполнялось
SELECT
  o.id AS order_id,
  p.name AS product,
  rs.step_no,
  op.name AS operation,
  e.name AS equipment,
  u.full_name AS operator,
  ol.started_at,
  ol.finished_at,
  ol.status,
  ol.result_note
FROM orders o
JOIN order_items oi ON oi.order_id = o.id
JOIN products p ON p.id = oi.product_id
JOIN route_steps rs ON rs.order_item_id = oi.id
JOIN operation_logs ol ON ol.route_step_id = rs.id
LEFT JOIN equipment e ON e.id = ol.equipment_id
LEFT JOIN users u ON u.id = ol.operator_id
JOIN operations op ON op.id = rs.operation_id
ORDER BY o.id, p.name, rs.step_no, ol.id;

-- Q5. Где сейчас заказ: текущий активный шаг (если есть), иначе следующий запланированный
-- (показывает "движение по цепочке" — главный запрос для преподавателя)
WITH steps AS (
  SELECT
    o.id AS order_id,
    p.name AS product,
    rs.id AS route_step_id,
    rs.step_no,
    op.name AS operation,
    w.name AS workshop,
    rs.status
  FROM orders o
  JOIN order_items oi ON oi.order_id = o.id
  JOIN products p ON p.id = oi.product_id
  JOIN route_steps rs ON rs.order_item_id = oi.id
  JOIN operations op ON op.id = rs.operation_id
  LEFT JOIN workshops w ON w.id = rs.workshop_id
)
SELECT *
FROM steps
WHERE status IN ('IN_PROGRESS', 'PLANNED')
ORDER BY order_id, product, CASE status WHEN 'IN_PROGRESS' THEN 0 ELSE 1 END, step_no;

-- Q6. История статусов заказа (жизненный цикл)
SELECT
  o.id AS order_id,
  h.status,
  h.changed_at,
  u.full_name AS changed_by,
  h.comment
FROM orders o
JOIN order_status_history h ON h.order_id = o.id
LEFT JOIN users u ON u.id = h.changed_by
ORDER BY o.id, h.changed_at;

-- Q7. Заказы с просрочкой (если due_date < сегодня и статус не DONE/CANCELED)
SELECT
  o.id,
  c.name AS customer,
  o.status,
  o.due_date,
  (CURRENT_DATE - o.due_date) AS days_overdue
FROM orders o
JOIN customers c ON c.id = o.customer_id
WHERE o.due_date IS NOT NULL
  AND o.due_date < CURRENT_DATE
  AND o.status NOT IN ('DONE', 'CANCELED')
ORDER BY days_overdue DESC;

-- Q8. Загрузка оборудования: сколько активных операций сейчас на каждом станке
SELECT
  e.id,
  e.name AS equipment,
  w.name AS workshop,
  COUNT(*) FILTER (WHERE ol.status = 'IN_PROGRESS') AS active_ops,
  COUNT(*) AS total_logs
FROM equipment e
LEFT JOIN workshops w ON w.id = e.workshop_id
LEFT JOIN operation_logs ol ON ol.equipment_id = e.id
GROUP BY e.id, e.name, w.name
ORDER BY active_ops DESC, e.name;

-- Q9. Средняя длительность выполнения операций (по завершённым логам)
SELECT
  op.name AS operation,
  AVG(EXTRACT(EPOCH FROM (ol.finished_at - ol.started_at)) / 60.0) AS avg_minutes,
  COUNT(*) AS done_count
FROM operation_logs ol
JOIN route_steps rs ON rs.id = ol.route_step_id
JOIN operations op ON op.id = rs.operation_id
WHERE ol.finished_at IS NOT NULL
  AND ol.started_at IS NOT NULL
GROUP BY op.name
ORDER BY avg_minutes DESC;

-- Q10. Сводка по цехам: сколько шагов выполняется/запланировано/завершено
SELECT
  w.name AS workshop,
  COUNT(*) FILTER (WHERE rs.status = 'PLANNED') AS planned_steps,
  COUNT(*) FILTER (WHERE rs.status = 'IN_PROGRESS') AS in_progress_steps,
  COUNT(*) FILTER (WHERE rs.status = 'DONE') AS done_steps
FROM route_steps rs
LEFT JOIN workshops w ON w.id = rs.workshop_id
GROUP BY w.name
ORDER BY w.name;

-- Q11. Топ-изделия по количеству в заказах
SELECT
  p.name AS product,
  SUM(oi.quantity) AS total_qty,
  COUNT(DISTINCT oi.order_id) AS orders_cnt
FROM order_items oi
JOIN products p ON p.id = oi.product_id
GROUP BY p.name
ORDER BY total_qty DESC;

-- Q12. Аналитическая витрина (materialized view): распределение по статусам и дням
SELECT *
FROM order_stats_mv
ORDER BY day, status;
