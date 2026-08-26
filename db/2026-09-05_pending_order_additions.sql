-- =============================================================================
-- CUPAI — Additions to an ALREADY PAID order are a separate, UNPAID part.
--
-- Problem: adding a product (or raising a quantity) on an order whose payment
-- was already confirmed used to (a) deduct the extra stock immediately and
-- (b) re-price the WHOLE basket, overwriting the amounts the customer already
-- paid and re-applying/removing old discounts.
--
-- Representation (no second order row, no change to payment_status semantics
-- of the paid part):
--   * items / subtotal_price / discount_amount / total_price
--       → the CONFIRMED (paid) part. Frozen, never touched by an addition.
--   * pending_items / pending_subtotal / pending_discount / pending_total
--       → the NEW addition, waiting for its own payment confirmation.
--   * a non-empty pending_items array IS the "unpaid addition" flag.
--
-- Stock for the addition is deducted ONLY when the merchant confirms it, via
-- the SAME `confirm_order_payment` entry point. `update_order_with_stock` and
-- the delta logic for a still-pending order are untouched.
--
-- Safe to re-run.
-- =============================================================================

alter table public.orders
  add column if not exists pending_items    jsonb   not null default '[]'::jsonb,
  add column if not exists pending_subtotal numeric not null default 0,
  add column if not exists pending_discount numeric not null default 0,
  add column if not exists pending_total    numeric not null default 0,
  add column if not exists pending_since    timestamptz;

-- ---------------------------------------------------------------------------
-- Shared item helpers (same normalized matching used everywhere else).
-- ---------------------------------------------------------------------------

-- Availability check only: locks the matching variants, deducts NOTHING.
create or replace function public.cupai_item_shortages(
  p_items   jsonb,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item      jsonb;
  v_product   uuid;
  v_color     text;
  v_size      text;
  v_qty       integer;
  v_available integer;
  v_shortages jsonb := '[]'::jsonb;
begin
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    v_qty := coalesce((v_item->>'quantity')::numeric, 0)::integer;
    if v_qty <= 0 then continue; end if;
    v_product := public.cupai_resolve_product(v_item, p_user_id);
    if v_product is null then continue; end if;
    v_color := nullif(public.cupai_norm(v_item->>'color'), '');
    v_size  := nullif(public.cupai_norm(v_item->>'size'), '');

    select coalesce(sum(greatest(coalesce(pv.stock, 0), 0)), 0)::integer
      into v_available
    from (
      select pv.*
      from public.product_variants pv
      where pv.product_id = v_product
        and (v_color is null or public.cupai_norm(pv.color) = v_color)
        and (v_size  is null or public.cupai_norm(pv.size)  = v_size)
      order by pv.id
      for update
    ) pv;

    if v_available < v_qty then
      v_shortages := v_shortages || jsonb_build_object(
        'product_name', v_item->>'product_name',
        'color',        v_item->>'color',
        'size',         v_item->>'size',
        'requested',    v_qty,
        'available',    v_available
      );
    end if;
  end loop;

  return v_shortages;
end;
$$;

-- Deducts every line and returns the stock_deducted entries. Raises (rolling
-- the whole transaction back) if a line cannot be fully served.
create or replace function public.cupai_deduct_items(
  p_items   jsonb,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item     jsonb;
  v_product  uuid;
  v_color    text;
  v_size     text;
  v_qty      integer;
  v_need     integer;
  v_take     integer;
  v_row      record;
  v_deducted jsonb := '[]'::jsonb;
begin
  for v_item in select * from jsonb_array_elements(coalesce(p_items, '[]'::jsonb))
  loop
    v_qty := coalesce((v_item->>'quantity')::numeric, 0)::integer;
    if v_qty <= 0 then continue; end if;
    v_product := public.cupai_resolve_product(v_item, p_user_id);
    if v_product is null then continue; end if;
    v_color := nullif(public.cupai_norm(v_item->>'color'), '');
    v_size  := nullif(public.cupai_norm(v_item->>'size'), '');
    v_need  := v_qty;

    for v_row in
      select pv.id, greatest(coalesce(pv.stock, 0), 0) as stock
      from public.product_variants pv
      where pv.product_id = v_product
        and (v_color is null or public.cupai_norm(pv.color) = v_color)
        and (v_size  is null or public.cupai_norm(pv.size)  = v_size)
      order by greatest(coalesce(pv.stock, 0), 0) desc, pv.id
      for update
    loop
      exit when v_need <= 0;
      v_take := least(v_need, v_row.stock);
      if v_take > 0 then
        update public.product_variants
          set stock = greatest(coalesce(stock, 0), 0) - v_take
          where id = v_row.id;
        v_deducted := v_deducted || jsonb_build_object('variant_id', v_row.id, 'quantity', v_take);
        v_need := v_need - v_take;
      end if;
    end loop;

    if v_need > 0 then
      raise exception 'insufficient stock for %', v_item->>'product_name';
    end if;
  end loop;

  return v_deducted;
end;
$$;

-- Merges basket B into basket A by product/colour/size, summing quantities and
-- line totals. Used to fold a confirmed addition into the paid basket.
create or replace function public.cupai_merge_items(
  p_base     jsonb,
  p_addition jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare
  v_out   jsonb := coalesce(p_base, '[]'::jsonb);
  v_add   jsonb;
  v_i     integer;
  v_cur   jsonb;
  v_found boolean;
begin
  for v_add in select * from jsonb_array_elements(coalesce(p_addition, '[]'::jsonb))
  loop
    v_found := false;
    for v_i in 0 .. greatest(jsonb_array_length(v_out) - 1, 0)
    loop
      exit when jsonb_array_length(v_out) = 0;
      v_cur := v_out -> v_i;
      if public.cupai_norm(v_cur->>'product_name') = public.cupai_norm(v_add->>'product_name')
         and public.cupai_norm(v_cur->>'color') = public.cupai_norm(v_add->>'color')
         and public.cupai_norm(v_cur->>'size')  = public.cupai_norm(v_add->>'size')
      then
        v_out := jsonb_set(
          v_out,
          array[v_i::text],
          v_cur
            || jsonb_build_object(
                 'quantity',
                 coalesce((v_cur->>'quantity')::numeric, 0) + coalesce((v_add->>'quantity')::numeric, 0),
                 'line_total',
                 coalesce((v_cur->>'line_total')::numeric, 0) + coalesce((v_add->>'line_total')::numeric, 0)
               )
        );
        v_found := true;
        exit;
      end if;
    end loop;
    if not v_found then
      v_out := v_out || jsonb_build_array(v_add);
    end if;
  end loop;

  return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- add_pending_order_items — records an addition on an ALREADY PAID order as an
-- unpaid part. Nothing about the paid part changes and NO stock is deducted.
-- p_pending_items is the COMPLETE pending basket (old pending + the addition),
-- priced on the new lines only.
-- ---------------------------------------------------------------------------
create or replace function public.add_pending_order_items(
  p_order_number     text,
  p_conversation_id  uuid,
  p_merchant_id      uuid,
  p_pending_items    jsonb,
  p_pending_subtotal numeric,
  p_pending_discount numeric,
  p_pending_total    numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order     record;
  v_user_id   uuid;
  v_shortages jsonb;
begin
  select * into v_order
  from public.orders
  where order_number = p_order_number
    and conversation_id = p_conversation_id
    and merchant_id = p_merchant_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_order.status = 'cancelled' then
    return jsonb_build_object('ok', false, 'error', 'cancelled');
  end if;
  if coalesce(v_order.payment_status, 'confirmed') <> 'confirmed' then
    -- An unpaid order keeps the existing update path.
    return jsonb_build_object('ok', false, 'error', 'order_not_paid');
  end if;

  select m.user_id into v_user_id from public.merchants m where m.id = p_merchant_id;

  -- The pending part is not deducted yet, so the WHOLE pending basket must fit
  -- in the live stock.
  v_shortages := public.cupai_item_shortages(p_pending_items, v_user_id);
  if jsonb_array_length(v_shortages) > 0 then
    return jsonb_build_object('ok', false, 'error', 'insufficient_stock', 'shortages', v_shortages);
  end if;

  update public.orders
  set pending_items    = coalesce(p_pending_items, '[]'::jsonb),
      pending_subtotal = coalesce(p_pending_subtotal, 0),
      pending_discount = coalesce(p_pending_discount, 0),
      pending_total    = coalesce(p_pending_total, 0),
      pending_since    = coalesce(pending_since, now())
  where id = v_order.id;

  return jsonb_build_object(
    'ok', true,
    'order_number', p_order_number,
    'pending_addition', true,
    'pending_total', coalesce(p_pending_total, 0),
    'stock_deducted', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- confirm_order_payment — unchanged for a pending order; now also confirms an
-- unpaid ADDITION sitting on an already paid order.
-- ---------------------------------------------------------------------------
create or replace function public.confirm_order_payment(
  p_order_id    uuid,
  p_merchant_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_order     record;
  v_user_id   uuid;
  v_shortages jsonb;
  v_deducted  jsonb;
  v_offers    integer := 0;
begin
  select * into v_order
  from public.orders
  where id = p_order_id and merchant_id = p_merchant_id
  for update;

  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  if v_order.status = 'cancelled' then
    return jsonb_build_object('ok', false, 'error', 'cancelled');
  end if;

  select m.user_id into v_user_id from public.merchants m where m.id = p_merchant_id;

  -- ---- Already paid ----------------------------------------------------
  if coalesce(v_order.payment_status, 'confirmed') = 'confirmed' then
    if jsonb_array_length(coalesce(v_order.pending_items, '[]'::jsonb)) > 0 then
      -- Confirm ONLY the addition: verify, deduct the addition's stock, fold it
      -- into the paid basket and ADD its amounts to the confirmed amounts.
      v_shortages := public.cupai_item_shortages(v_order.pending_items, v_user_id);
      if jsonb_array_length(v_shortages) > 0 then
        return jsonb_build_object('ok', false, 'error', 'insufficient_stock', 'shortages', v_shortages);
      end if;

      v_deducted := public.cupai_deduct_items(v_order.pending_items, v_user_id);

      update public.orders
        set items           = public.cupai_merge_items(coalesce(items, '[]'::jsonb), v_order.pending_items),
            subtotal_price  = coalesce(subtotal_price, 0)  + coalesce(v_order.pending_subtotal, 0),
            discount_amount = coalesce(discount_amount, 0) + coalesce(v_order.pending_discount, 0),
            total_price     = coalesce(total_price, 0)     + coalesce(v_order.pending_total, 0),
            stock_deducted  = coalesce(stock_deducted, '[]'::jsonb) || v_deducted,
            pending_items    = '[]'::jsonb,
            pending_subtotal = 0,
            pending_discount = 0,
            pending_total    = 0,
            pending_since    = null,
            payment_confirmed_at = now()
        where id = p_order_id;

      v_offers := public.record_order_offer_redemptions(p_order_id, p_merchant_id);

      return jsonb_build_object(
        'ok', true,
        'addition_confirmed', true,
        'offers_handled', true,
        'offers_recorded', v_offers
      );
    end if;

    v_offers := public.record_order_offer_redemptions(p_order_id, p_merchant_id);
    return jsonb_build_object(
      'ok', true,
      'already_confirmed', true,
      'offers_handled', true,
      'offers_recorded', v_offers
    );
  end if;

  -- ---- Still pending: the original behaviour, unchanged ----------------
  v_shortages := public.cupai_item_shortages(v_order.items, v_user_id);
  if jsonb_array_length(v_shortages) > 0 then
    return jsonb_build_object('ok', false, 'error', 'insufficient_stock', 'shortages', v_shortages);
  end if;

  v_deducted := public.cupai_deduct_items(v_order.items, v_user_id);

  update public.orders
    set payment_status       = 'confirmed',
        payment_confirmed_at = now(),
        stock_deducted       = coalesce(stock_deducted, '[]'::jsonb) || v_deducted
    where id = p_order_id;

  v_offers := public.record_order_offer_redemptions(p_order_id, p_merchant_id);

  return jsonb_build_object(
    'ok', true,
    'offers_handled', true,
    'offers_recorded', v_offers
  );
end;
$$;

grant execute on function public.cupai_item_shortages(jsonb, uuid) to service_role;
grant execute on function public.cupai_deduct_items(jsonb, uuid) to service_role;
grant execute on function public.cupai_merge_items(jsonb, jsonb) to service_role;
grant execute on function public.add_pending_order_items(
  text, uuid, uuid, jsonb, numeric, numeric, numeric
) to service_role;
grant execute on function public.confirm_order_payment(uuid, uuid) to service_role;
