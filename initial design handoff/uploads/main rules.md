UI
	• We are writing a viewer UI web application for bots, I added a lot of details but you are free to be creative and change them.
	• Be creative about the performance page, What I would definitely like to see is daily performance, by percentage, by turkish liras, etc.
	• What I want to see/do about the positions, orders and trades
		○ "waiting order" means active, scheduled, scheduledBatch or unconfirmed. i.e: anything that can still be executed
		○ similar UI (don't have to be the same) for waiting/canceled orders, (open) positions, (closed) trades
			§ always related orders are shown together
				□ canceled orders can be hidden with a single checkbox (probably together with other filters)
				□ opening order on top, and others below it
		○ trades and canceled order are not editable
		○ activeand scheduled orders are editable as much as posibble
		○ active and scheduled orders are cancelable
		○ scheduled orders are cancellable
		○ canceled orders that are attached to positions are retriggerable (with a "send with change" option (edit some details or schedule them), or directly resend)
		○ positions can be closed by
			§ scheduled orders
			§ immediate orders
			§ limit/market, price, quantity details
			§ multiple closing orders possible (only if MatriksOrder API allows), quantity of new closing order is at most the remaining quantities (quantity of position minus total quantity of active/scheduled orders)
		○ top level filters:
			§ waiting, positions, trades, canceled (only for canceled opens)
			§ multiple bot selection
			§ multiple account selection
			§ symbol: textfield (more than one possible with comma)
			§ start date and end date by batches
		○ grouping orders is possible
			§ group as much as possible in the following order
				□ date are grouped (add a date header)
				□ orders of bots grouped together (add a yellow/golden vertical line)
				□ batches are grouped together (batch logic is the same the MatriksOrder-Report.html) (add a green vertical line)
			§ group only if it is possible (for exmpale if we sort by status it would be almost hard to group i assume)
		○ ignore "Durum filtresi (zincirdeki emirler):" in MatriksOrder-Report.html
		○ sorting (reserve order of all items below is also possible)
			§ status (active > unconfirmed > scheduled > scheduleBatch > position > trades > cancedled),
			§ opening date
			§ closing date
			§ symbol
		○ I want to see a summary (similart to MatriksOrder-Report.html) on the top the page about the visible (filtered) orders/positions/trade

Rules
	• Trading is complicated, trading with many bots is more compşicated. UI should be easily understandable by humans
	• Check MatriksOrder API if the features i want cannot be done currently by MatriksOrder API. Suggest changes to  the API if neeed
	• Unrealized P&L require live stock value, it comes from DailyDataAggregator 
	• Never change anything in these projects
