
Main Page
	• Sticky top Row
		○ Breadcrumbs: Main Page
		○ Performance Component (average and total for all bots)
		○ Bots Filter
			§ From Left to Right
				□ Active/Not Active checkable dropdown. Default: Active
				□ Complete/Not Complete checkable dropdown. Default: Both
				□ Emails checkable dropdown. Lists "All" & all unique emails in the bots data, default: All
				□ AccountId-BrokerageId dropdown. Lists "All" & all unique pairs in the bots data, default: All
			§ Aligned to Left covering all horizontal space available
		○ Top Right Component
	• Bots list
		○ rounded rectangle border with color
			§ if bot is not active -> red
			§ else if bot is complete -> green
			§ else -> orange
		○ Each item with below info
			§ first row
				□ first column: aligned to left
					® bot id
					® algorithm id
					® account id-brokerage id
					® account owner
				□ second column: aligned to left but covering horizontally all remaining area
					® description (height same as the total of the first column), if it doesn't fit ellipsize it, and show all info in hover
			§ second row
				□ buy order counts: shown as "Buys: #openBuyOrders/#scheduledBuyOrders"
					® #openBuyOrders: green
					® #scheduledBuyOrders: yellow
				□ position and linked sell counts: shown as "Positions: #openPositions/#openSellOrders/#scheduledSellOrders"
					® #openPositions: white
					® #openSellOrders: green
					® #scheduledSellOrders: yellow
			§ third row
				□ closed trades count
				□ Realized P&L both in TL and percentange to total bot budget
				□ Unrealized P&L and last updated
					® last updated info is shown if it's older than 5 minutes
					® format: X minutes/hours/days ago
					® new stock values are checked every minute (if there is active positions (or partially filled orders))
		○ first bots list is loaded from API and it shown, then other necessary info from the API and shown as we get load the info. so lazy loading here, but make UI size the same as it loads, don't make jumps in size as the data loads
	• Add Bot button: with Plus sign on the left, no borders, aligned to left
		○ When the the button is clicked "Add Bot button" is hidden and "Add bot UI" is shown
		○ Add bot UI:
			§ first column
				□ Bot Details Component (all editable fields, but "active" is not shown)
			§ second column (same height as first column, each row is almost 1.5x size compared to the first columns rows)
				□ first row: add button, green (ask for popup confirmation on click)
					® fail if botId is already taken: send ConfigureBot request, refetch bots data, reset UI to initial MainPage state
				□ second row: cancel button, red (ask for popup confirmation on click)
					®  "Add Bot UI" is hidden and "Add bot Button" is shown
		
Bot Details Page
	• Sticky top Row
		○ Breadcrumbs: Main Page (clickable) > Bot Details
		○ Filter
			§ Sections checkable dropdown. Lists "All", "Bot Details", "Open Buy Orders", "Scheduled Buy Orders", "Positions", default: All 
			§ Aligned to Left covering all horizontal space available
		○ Top Right Component
	• Bot Details
		○ first column
			§ Bot Details Component (all editable field except "id")
		○ second column (same height as first column, each row is almost 1.5x size compared to the first columns rows)
			§ first row: update button, green (ask for popup confirmation on click)
				□ sends update request and updates UI
			§ second row: cancel button, red (ask for popup confirmation on click)
				□ resets the fields 
	• Open Buy Orders: List of Order Components
	• Scheduled Buy Orders: List of Order Components
	• Positions: List of Order Components
	• Sticky bottom Row
		○ Closed Trades Button: Go to Closed Trades Page
		○ Canceled Buy Orders Button: Go to Canceled Buy Orders Page
		○ Performance Button: Go to Performance Page

Closed Trades Page
	• Sticky top Row
		○ Breadcrumbs: Main Page (clickable) > Bot Details (clickable) > Closed Trades
		○ Filter
			§ Profitable checkable dropdown. List "Winning", "Losing", default both selected, zero percent and up return is considered winning
			§ Aligned to Left covering all horizontal space available
		○ Top Right Component
	• Closed Trades: List of Order Components

Canceled Buy Orders Page (Only Orphans)
	• Sticky top Row
		○ Breadcrumbs: Main Page (clickable) > Bot Details (clickable) > Canceled Buy Orders 
		○ Filter
			§ Profitable checkable dropdown. List "Winning", "Losing", default both selected, zero percent and up return is considered winning
			§ Aligned to Left covering all horizontal space available
		○ Top Right Component
	• Canceled Buy Orders: List of Order Components

Performance Page
	• Sticky top Row
		○ Breadcrumbs: Main Page (clickable) > Bot Details (clickable) > Performance
		○ Top Right Component
	• For the main content here, I am thinking of sth like below, but you can ignore and add many ideas here, let's be creative
		○ show bot budget, number of winning trades, losing trades...
		○ create a 2d line graph winnings over time showing date by date realized performance, allow changes to daily, weekly, monthly...

Errors Page
	• Sticky top Row
		○ Breadcrumbs: Main Page (clickable) > Errors
		○ Errors Filter
			§ From Left to Right
				□ Error Type Dropdown: Default all (client side filtering)
				□ From Date: Default yesterday (request to server when changed, future Dates are disabled)
				□ To Date: Default today (request to server when changed, future Dates are disabled)
			§ Aligned to Left covering all horizontal space available
		○ Top Right Component
	• Errors List
		○ table with alternating rows colors
		○ each row is one line
		○ each row contains all fields of the errors response
		○ column widths are resizable
		○ sortable via columns (A->Z & Z->A or latest->oldest)
