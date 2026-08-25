Let's create a plan of a bot viewer web front end together. 
	• You will access DailyDataAggregator database (C:\Users\Administrator\Documents\projects\DailyDataAggregator\DATABASE.md)
	• You will access MatriksOrder API (C:\Users\Administrator\Documents\projects\MatriksOrder\API.md) for connecting to the bot server.
	• Please Read the requirements below and check if the api is missing anything. If yes, create a message what is needed from the API, so I'll ask an agent of the MatriksOrder.
	• You can try the api to see if you can get the responses as expected with one rule: For making buy orders, you can only try orders that won't fill, let's %5 percent lower than current price.

Glossary:
	• Batch: the trades that are opened in the same day, (closing day is irrelevant)
	• complete or incomplete trades (meaning just opening (buy) order, or opening order with closing (selling) order) 

Tech Details
	• Use React and TS
	• Single page application
	• The app is in dark mode only
	• Everything, code and UI in English
	• Make all pages as different folders or modules, and you can create a components folder or modules. and the pages will consume that, the other way around is not allowed. add that to the related readme that you'll create.
	• add a BistAPI boundary module/folder for connecting to MatriksOrder, reaching to MatriksOrder is never allowed outside of this module/folder.
	• add readme for all pages folders/modules, components folder/module and BistAPI module/folder, and a central readme on the top level, and a CLAUDE.md file.
	• You can consider adding other modules and readmes if you deem necessary.

Performance Component
	• One line, from left to right
		○ Latest batch's performance
	• Use weighted averages for percentages where possible, use totals for others

Top Right Component
	• From Left to Right
		○ Last updated: "Less than a minute ago" OR "X minutes/hours/days ago" OR "Loading..." the label is updated automatically when some time passes
		○ Refresh icon
		○ Errors icon: Opens Error Page (not shown in Errors Page)
	• Aligned to Right covering only required space

Bot Details Component
	• first row
		○ id ( string)
		□ algorithmId (string)
		□ accountId-brokerageId
			§ editable: (dropdown) with data from GetAccounts request
				□ if current saved accountId and brokerageId are empty add "empty" and select it
				□ else if current saved accountId-brokerageId does not match with one of the accounts, then add that to the dropdown with "invalid" to next to it in paranthesis
				□ otherwise the matching id item in the dropdown is selected
			§ not-editable: (string-string)
	• second row
		□ limit % (decimal number)
		□ limit (number)
		□ limit % per position (decimal number)
		□ limit per position (number),
	• third row
		□ emails (string converted from array separated with comma)
		□ active (checkbox)
	• fourth row
		□ description (string, multiline if necesarry)

Order Component
	• rounded rectangle border
		□ filled order (position, trade): white
		□ active order: green
		□ scheduled order: yellow
		□ canceled order: red
	• content
		□ clientOrderId-matriksOrderId-matriksOrderId2 (string-string-string)
		□ symbol (string)
		□ direction (string)
		□ type
			§ editable: (dropdown)
			§ non-editable: (string)
		□ orderPrice
			§ editable: (day (date selector), type (dropdown), diff (string)), this is like the type of "time" in EditOrders API request
			§ non-editable: (string)
		□ orderTime
			§ editable only for scheduled orders
			§ editable: 
			§ non-editable: (string)
		□ status
		
	• if there are linked orders for the order/position/trade
		□ linked orders are shown as a new Order Component inside the current Order Component
			§ border, border color and content is the same way, but there a bit padding inside the outer component, so the inner one is just a bit smaller
		□ linked sell orders are determined by requesting the below requests and matching order id
			§ GetActiveOrders/GetCanceledOrders for buy orders and positions
			§ GetClosedTrades/GetCanceledOrders for trades
	

Logic:
	• Necessary data is lazy loaded in a central not-persistent data sore, the data that the active page requires are fetched. And the data is not refetched when going to a page if we already have it. Refresh is done when the server sends an update event or user clicks the "Refresh icon" following the "Refresh logic"
	• Refresh logic:
		○ request new data from server
		○ during refresh
			§ refresh icon turns indefinitely
			§ Last updated label is "Loading..."
			§ Refresh and Last Updated field is disabled and grey colored to show it is disabled
		○ after the refresh is over, show updated data in the page, but keep the scroll position so the user is not confused
