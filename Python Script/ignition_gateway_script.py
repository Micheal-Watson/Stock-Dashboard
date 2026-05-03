def handleTimerEvent():
	import json
	import system.tag
	import system.util

	DATA_FILE    = "C:\\Users\\PC\\Downloads\\Stock Dashboard Project CC\\Python Script\\stock_data.json"
	TAG_PROVIDER = "[StockData]"
	TAG_BASE     = "[StockData]Stocks"
	logger       = system.util.getLogger("StockDashboard")

	FLOAT_FIELDS = [
		"price", "change_pct", "rsi", "sma_short", "sma_long", "vol_ratio",
		"high_52w", "low_52w", "pct_from_52w_high", "intrinsic_value",
		"dcf_margin", "analyst_target",
		"pe_ratio", "profit_margin", "cash_reserves", "total_debt", "rule_of_40"
	]
	INT_FIELDS = ["signal_int", "analyst_count"]
	STRING_FIELDS = [
		"signal_text", "reason", "last_updated", "error", "dcf_note",
		"analyst_consensus", "currency", "ai_overview", "our_rating"
	]
	# quarterly_data from the JSON becomes a typed Dataset tag — no string tag needed
	NUMERIC_FIELDS = FLOAT_FIELDS + INT_FIELDS

	def ensure_ticker_tags(safe_ticker):
		tag_defs = []
		for field in FLOAT_FIELDS:
			tag_defs.append({"name": field, "tagType": "AtomicTag", "dataType": "Float8", "value": 0.0})
		for field in INT_FIELDS:
			tag_defs.append({"name": field, "tagType": "AtomicTag", "dataType": "Int4", "value": 0})
		for field in STRING_FIELDS:
			tag_defs.append({"name": field, "tagType": "AtomicTag", "dataType": "String", "value": ""})
		# Dataset tag holds quarterly revenue/earnings — chart binds to this directly
		tag_defs.append({"name": "quarterly_dataset", "tagType": "AtomicTag", "dataType": "DataSet"})
		folder_config = [{"name": safe_ticker, "tagType": "Folder", "tags": tag_defs}]
		system.tag.configure(TAG_BASE, folder_config, "m")

	def ensure_stocks_folder():
		system.tag.configure(TAG_PROVIDER, [{"name": "Stocks", "tagType": "Folder"}], "m")

	def build_quarterly_dataset(json_str):
		"""Parse the quarterly_data JSON string and return an Ignition Dataset."""
		qd       = json.loads(str(json_str))
		quarters = qd.get("quarters", [])
		revenue  = qd.get("revenue",  [])
		earnings = qd.get("earnings", [])
		rows = []
		for i in range(len(quarters)):
			rv = float(revenue[i])  if i < len(revenue)  else 0.0
			ev = float(earnings[i]) if i < len(earnings) else 0.0
			rows.append([str(quarters[i]), rv, ev])
		return system.dataset.toDataSet(["Quarter", "Revenue", "Earnings"], rows)

	try:
		fh         = open(DATA_FILE, "r")
		raw        = fh.read()
		fh.close()
		stock_data = json.loads(raw)

		ensure_stocks_folder()

		tag_paths  = []
		tag_values = []

		for ticker, fields in stock_data.items():
			if ticker == "_meta":
				continue
			safe_ticker = ticker.replace(".", "_")
			ensure_ticker_tags(safe_ticker)

			for field_name, value in fields.items():

				# Convert quarterly JSON string → typed Dataset tag
				if field_name == "quarterly_data":
					try:
						ds = build_quarterly_dataset(value)
						tag_paths.append("{}/{}/quarterly_dataset".format(TAG_BASE, safe_ticker))
						tag_values.append(ds)
					except Exception as qe:
						logger.warning("quarterly_dataset error for {}: {}".format(safe_ticker, str(qe)))
					continue  # skip writing as a raw string tag

				tag_path = "{}/{}/{}".format(TAG_BASE, safe_ticker, field_name)
				if field_name in NUMERIC_FIELDS:
					try:
						value = float(value) if value is not None else 0.0
						if field_name in INT_FIELDS:
							value = int(value)
					except (ValueError, TypeError):
						value = 0
				elif field_name in STRING_FIELDS:
					value = str(value) if value is not None else ""
				else:
					continue  # ignore unknown fields (e.g. ai_overview if disabled)

				tag_paths.append(tag_path)
				tag_values.append(value)

		if tag_paths:
			system.tag.writeBlocking(tag_paths, tag_values)
			logger.info("Updated {} tags across {} tickers".format(
				len(tag_paths), len(stock_data) - 1
			))

	except Exception as e:
		logger.error("StockDataRefresh failed: {}".format(str(e)))
