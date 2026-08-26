-- =============================================================================
-- CUPAI — FIX: restore the missing offer-redemption helpers.
--
-- `confirm_order_payment` (2026-09-01) calls
-- `public.record_order_offer_redemptions(uuid, uuid)`. Databases where the
-- 2026-08-26 migration was never applied fail the whole payment confirmation
-- with: function public.record_order_offer_redemptions(uuid, uuid) does not exist.
--
-- This file re-creates ONLY the helpers (same logic as 2026-08-26). It does not
-- touch confirm_order_payment. Safe to re-run.
-- =============================================================================

-- Order total: the stored total, or the sum of the item lines when absent.
create or replace function public.order_total_value(p_order public.orders)
returns numeric
language plpgsql
immutable
set search_path = public
as $$
declare
  v_item  jsonb;
  v_total numeric := 0;
begin
  if p_order.total_price is not null then
    return coalesce(p_order.total_price, 0);
  end if;
  for v_item in select * from jsonb_array_elements(coalesce(p_order.items, '[]'::jsonb))
  loop
    v_total := v_total
      + coalesce(
          nullif(v_item->>'price', '')::numeric,
          nullif(v_item->>'unit_price', '')::numeric,
          0
        )
      * coalesce(nullif(nullif(v_item->>'quantity', '')::numeric, 0), 1);
  end loop;
  return v_total;
end;
$$;

-- Stable identity of the customer behind an order (same order of precedence as
-- customerKeyOf() in the application code).
create or replace function public.order_customer_key(p_order public.orders)
returns text
language sql
immutable
set search_path = public
as $$
  select case
    when coalesce(btrim(p_order.customer_id::text), '') <> ''      then 'c:' || btrim(p_order.customer_id::text)
    when coalesce(btrim(p_order.customer_phone), '') <> ''         then 'p:' || btrim(p_order.customer_phone)
    when coalesce(btrim(p_order.conversation_id::text), '') <> ''  then 'v:' || btrim(p_order.conversation_id::text)
    else 'o:' || p_order.id::text
  end;
$$;

-- ---------------------------------------------------------------------------
-- record_order_offer_redemptions — records every offer that applies to an
-- already PAID order and refreshes that offer's counters. Idempotent.
-- ---------------------------------------------------------------------------
create or replace function public.record_order_offer_redemptions(
  p_order_id    uuid,
  p_merchant_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order        public.orders;
  v_user_id      uuid;
  v_total        numeric;
  v_key          text;
  v_offer        record;
  v_applies      boolean;
  v_already_used boolean;
  v_inserted     integer;
  v_recorded     integer := 0;
begin
  select * into v_order
  from public.orders
  where id = p_order_id and merchant_id = p_merchant_id;
  if not found then
    return 0;
  end if;

  -- Never count an order that is not actually paid.
  if coalesce(v_order.payment_status, 'confirmed') <> 'confirmed' then
    return 0;
  end if;
  if v_order.status = 'cancelled' then
    return 0;
  end if;

  select m.user_id into v_user_id from public.merchants m where m.id = p_merchant_id;
  if v_user_id is null then
    return 0;
  end if;

  v_total := public.order_total_value(v_order);
  v_key   := public.order_customer_key(v_order);

  for v_offer in
    select o.*, p.name as product_name
    from public.offers o
    left join public.products p on p.id = o.product_id
    where o.user_id = v_user_id
      and o.is_active is not false
      and coalesce(o.starts_at, now()) <= now()
      and (o.ends_at is null or o.ends_at > now())
      and (
        o.max_redemptions is null
        or o.max_redemptions <= 0
        or coalesce(o.beneficiary_count, 0) < o.max_redemptions
      )
    order by o.id
    for update of o
  loop
    -- min_order_total
    if v_offer.min_order_total is not null and v_total < v_offer.min_order_total then
      continue;
    end if;

    -- scope
    if coalesce(v_offer.scope, 'product') = 'all' then
      v_applies := true;
    elsif coalesce(btrim(v_offer.product_name), '') = '' then
      v_applies := false;
    else
      select exists (
        select 1
        from jsonb_array_elements(coalesce(v_order.items, '[]'::jsonb)) it
        where lower(btrim(coalesce(it->>'product_name', ''))) = lower(btrim(v_offer.product_name))
      ) into v_applies;
    end if;
    if not v_applies then
      continue;
    end if;

    -- "once per customer": a customer who already benefited never counts again.
    select exists (
      select 1 from public.offer_redemptions r
      where r.offer_id = v_offer.id and r.customer_key = v_key
    ) into v_already_used;
    if coalesce(v_offer.usage_limit_type, 'per_order') = 'once_per_customer' and v_already_used then
      continue;
    end if;

    insert into public.offer_redemptions (
      offer_id, order_id, conversation_id, customer_name, order_total, customer_key
    ) values (
      v_offer.id, v_order.id, v_order.conversation_id, v_order.customer_name, v_total, v_key
    )
    on conflict (offer_id, order_id) do nothing;

    get diagnostics v_inserted = row_count;
    v_recorded := v_recorded + coalesce(v_inserted, 0);

    -- Counters are always recomputed from the rows themselves, so they self-heal
    -- even if an earlier run stopped half-way.
    update public.offers o
      set redemption_count = stats.uses,
          beneficiary_count = stats.customers
    from (
      select count(*)::integer as uses,
             count(distinct coalesce(r.customer_key, r.order_id::text))::integer as customers
      from public.offer_redemptions r
      where r.offer_id = v_offer.id
    ) stats
    where o.id = v_offer.id
      and (o.redemption_count is distinct from stats.uses
        or o.beneficiary_count is distinct from stats.customers);
  end loop;

  return v_recorded;
end;
$$;

grant execute on function public.order_total_value(public.orders) to service_role;
grant execute on function public.order_customer_key(public.orders) to service_role;
grant execute on function public.record_order_offer_redemptions(uuid, uuid) to service_role;
