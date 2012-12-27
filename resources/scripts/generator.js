/*global $:false,CodeMirror:false,console:false */
define([
	"manager",
	"pluginManager",
	"utils",
	"queue",
	"constants",
	"lang",
	"moment",
	"jquery-ui"
], function(manager, pluginManager, utils, Queue, C, L, moment) {

	"use strict";

	/**
	 * @name Generator
	 * @see Core
	 * @description This file contains the core client-side code for the Data Generator. It initializes the default
	 * functionality of the generator page, subscribes to and publishes all the appropriate Core events and
	 * offers a few public functions for use by any plugins running custom JS code.
	 * @author Ben Keen
	 * @return {Object}
	 * @namespace
	 */

	var MODULE_ID = "core-generator";
	var _numRows  = 0;
	var _numRowsToShowOnStart = 4;
	var _countries = [];
	var _currExportType = null; // populated onload
	var _showExportTypeSettings = true;
	var _codeMirror = null;
	var _lastSelectedDataType = null;

	// the number of results being generated
	var _numRowsToGenerate;

	// for storing data during in-page data generation
	var _generateInPageRunningCount;
	var _generateInPageBatchNum;
	var _generateInPageData;
	var _generateInPageContent = "";
	var _isGenerating = false;
	var _generationCancelled = false;

	var _currHelpDialogTab = 1;
	var _currDataTypeHelp = null;

	// accounts
	var _isLoaded = false;
	var _accountInfo = null;
	var _dataSets = [];
	var _currConfigurationID = null;


	/**
	 * Called when everything is loaded. This binds the appropriate event handlers and sets up the
	 * page.
	 */
	var _run = function() {
		utils.startProcessing();

		// retrieve the data sets for the current user
		_getAccount();

		$("#gdDataSetName").focus();
		$("#gdCountries").chosen().change(_updateCountryChoice);
		$("#gdGenerateButton,#gdRegenerateButton").on("click", _generateData);
		$("#gdBackButton").on("click", _onClickBackButton);

		$("#gdShowSettingsLink").bind("click", function() {
			if (_showExportTypeSettings) {
				_hideExportTypeSettingsSection();
			} else {
				_showExportTypeSettingsSection(_currExportType);
			}
			return false;
		});

		// each event is handled separately to ensure that the Change Data Type event isn't unnecessarily
		// republished. Only really an issue on Firefox, which publishes keyup and change events when
		// changing the selected option via the keyboard (up and down). It also allows us to tab off the field
		// into whatever field is displayed next.
		$("#gdTableRows").on("change keyup", ".gdDataType", _onChangeDataType);
		$("#gdTableRows").on("focus", ".gdDataType", _onFocusDataType);
		$("#gdTableRows").on("change", ".gdDeleteRows", _markRowToDelete);
		$("#gdTableRows").on("change", ".gdColExamples select", _publishExampleChange);

		$("#gdTableRows").sortable({
			handle: ".gdColOrder",
			axis: "y",
			update: function(event, ui) {
				_updateVisibleRowNums();
				manager.publish({
					sender: MODULE_ID,
					type: C.EVENT.DATA_TABLE.ROW.RE_SORT,
					row: ui.item
				});
			}
		});

		$(document).on("click", ".gdMessageClose", function(e) {
			$(e.target).closest(".gdMessage").hide("blind", null, 500);
			return false;
		});

		$("#gdData").bind("submit", _generateData);
		$("#gdExportTypeTabs>ul>li").bind("click", function(e) {
			_selectExportTypeTab($(e.target).data("exportType"));
		});

		$(".gdAddRowsBtn").bind("click", function() { _addRows($("#gdNumRowsToAdd").val()); });
		$(".gdDeleteRowsBtn").bind("click", _deleteRows);
		$("#gdResetPluginsBtn").bind("click", _resetPluginsDialog);
		$("#gdTextSize").on("click", "li", _changeTextSize);
		$("#gdGenerationPanelCancel").on("click", _cancelGeneration);

		// icon actions
		$("#gdSaveBtn").on("click", _onClickSaveIcon);
		$("#gdSaveDataSet").on("click", _saveDataSet);
		$("#gdEmptyForm").bind("click", _emptyForm);

		// main dialog
		$("#gdLoadLink").on("click", function() { return _openMainDialog({ tab: 2 }); });
		$("#gdAccountDataSets").on("click", "a", _loadDataSet);
		$("#gdAccountDataSets").on("change", ".gdDeleteDataSets", _onChangeMarkDataSetRowToDelete);
		$("#gdAccountDataSets").on("click", _onClickToggleDeleteRow);
		$(".gdDeleteDataSetsBtn").bind("click", _confirmDeleteDataSets);
		$("#gdDataSetHelpNav").on("click", "a", _onclickDataTypeHelpNav);
		$("#gdTableRows").on("click", ".ui-icon-help", _onClickDataSetRowHelp);
		$("#gdSelectAllDataSets").on("click", _onToggleSelectAllDataSets);

		_initMainDialog();
		_initExportTypeTab();
		_updateCountryChoice();
		_addRows(_numRowsToShowOnStart);
		_initInPageCodeMirror();
		_initTooltips();
	};


	/**
	 * Called when the user clicks the "LOAD" link for a particular data set. This queries the account Manager
	 * to retrieve the data set, and then displays the information in the page.
	 */
	var _loadDataSet = function(e) {
		e.preventDefault();

		utils.startProcessing();

		var configurationID = $(e.target).closest("tr").data("id");
		var configuration = _getConfiguration(configurationID);
		var json = $.evalJSON(configuration.content);
		var numRows = json.hasOwnProperty("dataTypes") ? json.dataTypes.length : _numRowsToShowOnStart;

		// clear the form
		_clearForm(numRows);

		// now the form's been cleared, store the new configuration ID
		_currConfigurationID = configurationID;

		// now start populating the page
		$("#gdDataSetName").val(configuration.configuration_name);
		$("#gdNumRowsToGenerate").val(json.numResults);
		$("input[name=gdExportTarget]").val(json.exportTarget);

		_updateCountries(json.countries);

		// update the Export Types section
		_selectExportTypeTab(json.selectedExportType, true);
		manager.loadExportType(json.selectedExportType, json.exportTypes);


		// now populate the rows. Do everything that we can: create the rows, populate the titles & select
		// the data type. The remaining fields are custom to the data type, so we leave them to their
		// .loadData function (if defined)
		if (json.hasOwnProperty("dataTypes")) {
			var numDataTypeRows = json.dataTypes.length;
			var orderedRowIDs = _getRowOrder();
			
			var data = [];
			for (var i=0; i<numDataTypeRows; i++) {
				var currDataType = json.dataTypes[i];
				var currRowID = orderedRowIDs[i];
				$("#gdTitle_" + currRowID).val(currDataType.title);
				$("#gdDataType_" + currRowID).val(currDataType.dataType);
				_publishDataTypeChange($("#gdDataType_" + currRowID)[0]);

				currDataType.rowID = currRowID;
				data.push(currDataType);
			}

			manager.loadDataTypeRows(data);
		}

		utils.stopProcessing();

		_closeMainDialog();
	};


	var _updateCountries = function(countries) {
		$("#gdCountries option").each(function() {
			if ($.inArray(this.value, countries) != -1) {
				this.selected = true;
			} else {
				this.selected = false;
			}
		});
		$("#gdCountries").trigger("liszt:updated");
		_updateCountryChoice();
	};


	var _showSubtab = function(tab) {
		if (tab == 1) {
			$("#gdGenerateSubtab1").show();
			$("#gdGenerateSubtab2").hide();
			$("#gdEmptyForm,#gdLoadLink").show();
		} else {
			$("#gdGenerateSubtab1").hide();
			$("#gdGenerateSubtab2").show();
			$("#gdEmptyForm,#gdLoadLink").hide();
		}
		return false;
	};


	/**
	 * Called when the user clicks the save icon. This intelligently decides how to save the information,
	 * based on whether it's a totally new data set, or if the user had loaded one already.
	 */
	var _onClickSaveIcon = function() {
		if (_currConfigurationID === null) {
			_saveDataSet();
		} else {
			// confirmation...?
			_saveDataSet();
		}
		return false;
	};


	/**
	 * Serializes the current data set and passes it over to the Account Manager to actually save.
	 */
	var _saveDataSet = function() {
		var buttons = [];
		var newDataSetName = $("#gdDataSetName").val();

		// if there's no Data Set name provided, briefly highlight the field to draw attention to it
		// and halt the process
		if (!newDataSetName) {
			$("#gdDataSetName").css({
				backgroundColor: "#770000",
				borderTopColor: "#550000",
				borderLeftColor: "#550000",
				borderBottomColor: "#550000"
			}).animate({
				backgroundColor: "#ffffff",
				borderTopColor: "#cccccc",
				borderLeftColor: "#cccccc",
				borderBottomColor: "#cccccc"
			}, 1500);
			return false;
		}

		var rowData = [];
		var orderedRowIDs = _getRowOrder();
		for (var i=0; i<orderedRowIDs.length; i++) {
			var rowNum  = orderedRowIDs[i];
			var rowDataType = $("#gdDataType_" + rowNum).val();
			if (rowDataType === "") {
				continue;
			}

			rowData.push({
				title: $("#gdTitle_" + rowNum).val(),
				dataType: rowDataType,
				data: manager.serializeDataTypeRow(rowDataType, rowNum)
			});
		}

		var configuration = {
			action: "saveConfiguration",
			dataSetName: newDataSetName,
			exportTarget: _getExportTarget(),
			numResults: _getNumRowsToGenerate(),
			countries: _countries,
			dataTypes: rowData,
			exportTypes: manager.serializeExportTypes(),
			selectedExportType: _currExportType
		};

		if (_currConfigurationID !== null) {
			configuration.configurationID = _currConfigurationID;
		}

		utils.startProcessing();
		$.ajax({
			url:  "ajax.php",
			type: "POST",
			dataType: "json",
			data: configuration,
			success: function(response) {
				if (response.success) {
					_currConfigurationID = response.content;
					_getAccount();
				} else {
					// TODO
				}
			},

			error: function() {
				// alert(L.fatal_error);
				// gd.stopProcessing();
			}
		});
	};


	var _addRows = function(rows) {
		rows = rows.toString();
		if (rows.match(/\D/) || rows === 0 || rows === "") {
			utils.clearValidationErrors($("#gdTab1Content"));
			utils.addValidationErrors({ els: [$("#gdNumRowsToAdd")], error: L.no_num_rows });
			utils.displayValidationErrors("#gdMessages");
			return false;
		}

		var rowIDs = [];
		var numRowsToAdd = parseInt(rows, 10);
		for (var i=1; i<=numRowsToAdd; i++) {
			var currRow = ++_numRows;
			rowIDs.push(currRow);
			var newRowHTML = $("#gdTableRowTemplate").html().replace(/%ROW%/g, currRow);
			$("#gdTableRows").append('<li class="gdTableRow" id="row_' + currRow + '">' + newRowHTML + '</li>');
		}

		_updateVisibleRowNums();

		// curious! This is done to force Chrome to do a redraw/repaint after adding rows
		$("body").addClass("forceRedraw").removeClass("forceRedraw");

		manager.publish({
			sender: MODULE_ID,
			type: C.EVENT.DATA_TABLE.ROW.ADD,
			numRows: rows,
			rowIDs: rowIDs
		});
	};


	/**
	 * This is called when the user actually clicks one of the DEL buttons, deleting those rows marked
	 * as deleted.
	 *
	 * @function
	 * @private
	 */
	var _deleteRows = function() {
		var rowIDs = [];
		$(".gdDeleteRows:checked").each(function() {
			var row = $(this).closest(".gdTableRow");
			var parentRowID = row.attr("id");
			if (parentRowID !== null) {
				var rowID = parseInt(parentRowID.replace(/row_/g, ""), 10);
				row.remove();
				rowIDs.push(rowID);
			}
		});

		manager.publish({
			sender: MODULE_ID,
			type: C.EVENT.DATA_TABLE.ROW.DELETE,
			rowIDs: rowIDs
		});

		_updateVisibleRowNums();
	};

	var _updateVisibleRowNums = function() {
		$("#gdTableRows>li .gdColOrder").each(function(i) { $(this).html(i+1); });
	};

	var _markRowToDelete = function(e) {
		var el = e.target;
		var event = null;
		if (el.checked) {
			$(el).closest(".gdTableRow").addClass("gdDeletedRow").effect("highlight", { color: "#cc0000" }, 1000);
			event = C.EVENT.DATA_TABLE.ROW.CHECK_TO_DELETE;
		} else {
			$(el).closest(".gdTableRow").removeClass("gdDeletedRow");
			event = C.EVENT.DATA_TABLE.ROW.UNCHECK_TO_DELETE;
		}
		manager.publish({
			sender: MODULE_ID,
			type: event,
			row: el
		});
	};

	/**
	 * Resets the entire page back to its defaults: default countries, a blank table and the default data
	 * format. The optional object param lets you optionally display a confirmation modal and reset the
	 * the table to the default num of rows.
	 * @function
	 * @private
	 * @name#Generator
	 */
	var _emptyForm = function(settings) {
		var opts = $.extend({
			requireConfirmation: true,
			numRows: _numRowsToShowOnStart
		}, settings);

		if (opts.requireConfirmation) {
			$("#gdEmptyFormDialog").html(L.confirm_empty_form).dialog({
				title: "Please confirm",
				modal: true,
				width: 400,
				buttons: [
					{
						text: "Yes",
						click: function() {
							_clearForm(opts.numRows);
							$(this).dialog("close");
						}
					},
					{
						text: "No",
						click: function() {
							$(this).dialog("close");
						}
					}
				]
			});
		} else {
			_clearForm(opts.numRows);
		}

	};

	var _clearForm = function(numDefaultRows) {
		$("#gdDataSetName").val("");
		$("#gdTableRows .gdDeleteRows").attr("checked", "checked");
		_deleteRows();
		_addRows(numDefaultRows);
		_currConfigurationID = null;
		_selectExportTypeTab($(".gdDefaultExportType").data("exportType"), true);
		manager.resetExportTypes();

		manager.publish({
			sender: MODULE_ID,
			type: C.EVENT.DATA_TABLE.CLEAR
		});
	};

	/**
	 * Called whenever the user selects or deselects a Country. If any modules need to do
	 * anything special, they can subscribe to the appropriate event.
	 */
	var _updateCountryChoice = function() {
		_countries.length = 0;
		$("#gdCountries option").each(function() {
			if (this.selected) {
				_countries.push(this.value);
			}
		});
		manager.publish({
			sender: MODULE_ID,
			type: C.EVENT.COUNTRIES.CHANGE,
			countries: _countries
		});
	};

	var _initExportTypeTab = function() {
		var newExportType = $("#gdExportTypeTabs li.gdSelected").data("exportType");
		_selectExportTypeTab(newExportType);
	};

	/**
	 * Called whenever the user changes the result type (XML, HTML, CSV etc). This function publishes
	 * the appropriate event in case a plugin needs to be aware of the event, but it handles the
	 * hiding/showing and changing of the title column label "out-the-box" rather than force
	 * the Export Type modules to have to do the work.
	 */
	var _selectExportTypeTab = function(newExportType, showImmediately) {
		if (newExportType == _currExportType) {
			return;
		}

		if (_currExportType !== null) {
			$("#gdExportTypeTabs>ul>li").removeClass("gdSelected");
			$("#gdExportType_" + newExportType).addClass("gdSelected");
		}

		// always reset the column heading to the default "Column Title". Export Types have the option
		// to overwrite it through the publish event below
		$("#gdColTitleTop,#gdColTitleBottom").html(L.row_label);

		manager.publish({
			sender: MODULE_ID,
			type: C.EVENT.RESULT_TYPE.CHANGE,
			newExportType: newExportType,
			oldExportType: _currExportType
		});

		// hide and show the appropriate Export Type additional settings section (if the + showdata format options link
		// has been clicked)
		if (_showExportTypeSettings) {
			_showExportTypeSettingsSection(newExportType, showImmediately);
		}

		_currExportType = newExportType;
	};


	var _showExportTypeSettingsSection = function(newExportType, showImmediately) {
		if ($("#gdExportTypeAdditionalSettings_" + _currExportType).length > 0 && _showExportTypeSettings) {
			if (showImmediately === true) {
				$("#gdExportTypeAdditionalSettings_" + _currExportType).hide();
			} else {
				$("#gdExportTypeAdditionalSettings_" + _currExportType).hide("blind", C.EXPORT_TYPE_SETTINGS_BLIND_SPEED);
			}
		}
		if (_currExportType === null || showImmediately === true) {
			$("#gdExportTypeAdditionalSettings_" + newExportType).show();
		} else {
			$("#gdExportTypeAdditionalSettings_" + newExportType).show(
				"blind",
				C.EXPORT_TYPE_SETTINGS_BLIND_SPEED,
				function() {
					_showExportTypeSettings = true;
					$("#gdShowSettingsLink span").html("-");
					$("#gdShowSettingsLink a").html("hide data format options");
				}
			);
		}
	};

	var _hideExportTypeSettingsSection = function() {
		$("#gdExportTypeAdditionalSettings_" + _currExportType).hide(
			"blind",
			C.EXPORT_TYPE_SETTINGS_BLIND_SPEED,
			function() {
				_showExportTypeSettings = false;
				$("#gdShowSettingsLink span").html("+");
				$("#gdShowSettingsLink a").html("show data format options");
			}
		);
	};

	var _publishExampleChange = function(e) {
		var select = e.target;
		var rowElement = $(select).closest(".gdTableRow");
		var rowID = parseInt($(rowElement).attr("id").replace(/^row_/, ""), 10);
		var dataTypeFolder = $(rowElement).find(".gdDataType").val();

		manager.publish({
			sender: MODULE_ID,
			type: C.EVENT.DATA_TABLE.ROW.EXAMPLE_CHANGE + "__" + dataTypeFolder,
			rowID: rowID,
			value: select.value
		});
	};

	/**
	 * Called whenever the user focuses on a Row Type. This makes a note of the last selected
	 * Data Type, to prevent unnecessary re-publishing of (non-)changed data types.
	 */
	var _onFocusDataType = function(e) {
		_lastSelectedDataType = e.target.value;
	};

	/**
	 * Called when the user changes the Data Type for a particular row.
	 */
	var _onChangeDataType = function(e) {
		if (e.target.value != _lastSelectedDataType) {
			_publishDataTypeChange(e.target);
		}
	};

	var _publishDataTypeChange = function(el) {
		var rowID = parseInt($(el).attr("id").replace(/^gdDataType_/, ""), 10);
		var dataTypeModuleID = el.value;

		// make a note of the last value
		_lastSelectedDataType = dataTypeModuleID;

		// if the user just selected the empty value ("Please Select"), clear everything
		if (dataTypeModuleID === "") {
			$('#gdColExamples_' + rowID + ',#gdColOptions_' + rowID + ',#gdColHelp_' + rowID).html("");
			return;
		}

		// update the example + options divs
		var exampleHTML = null;
		var optionsHTML = null;
		var dataTypeExampleHTML = $("#gdDataTypeExamples_" + dataTypeModuleID).html();
		if (dataTypeExampleHTML !== "") {
			exampleHTML = dataTypeExampleHTML.replace(/%ROW%/g, rowID);
		} else {
			exampleHTML = "&nbsp;" + L.no_examples_available;
		}
		$("#gdColExamples_" + rowID).html(exampleHTML);

		var dataTypeOptionHTML = $("#gdDataTypeOptions_" + dataTypeModuleID).html();
		if (dataTypeOptionHTML !== "") {
			optionsHTML = dataTypeOptionHTML.replace(/%ROW%/g, rowID);
		} else {
			optionsHTML = L.no_options_available;
		}
		$("#gdColOptions_" + rowID).html(optionsHTML);

		if ($("#gdDataTypeHelp_" + dataTypeModuleID).html() !== "") {
			$('#gdColHelp_' + rowID).html($("#gdHelpIcon").html().replace(/%ROW%/g, rowID));
		} else {
			$('#gdColHelp_' + rowID).html(" ");
		}

		// now public the 
		manager.publish({
			sender: MODULE_ID,
			type: C.EVENT.DATA_TABLE.ROW.TYPE_CHANGE,
			rowID: rowID,
			dataTypeModuleID: dataTypeModuleID
		});

/*
		// this is called whenever the row content (Options + Examples nodes) have been fully populated and the
		// DOM is ready
		var onComplete = function() {
			manager.publish({
				sender: MODULE_ID,
				type: C.EVENT.DATA_TABLE.ROW.TYPE_CHANGE,
				rowID: rowID,
				dataTypeModuleID: dataTypeModuleID
			});
		};

		// our two "is ready" tests, which depend on the content for the current Data Type
		var noOptionsTest = function() {
			onComplete();
			return true;
		};

		// this sucks!!
		var hasOptionsTest = function() {
			var isReady = (typeof $("#dtOption_" + rowID) != "undefined");
			if (isReady) {
				onComplete();
			}
			return isReady;
		};
		var readyTest = ($("#gdDataTypeOptions_" + dataTypeModuleID).length > 0) ? hasOptionsTest : noOptionsTest;

		Queue.add({
			execute: function() {
				var exampleHTML = null;
				var optionsHTML = null;
				var dataTypeExampleHTML = $("#gdDataTypeExamples_" + dataTypeModuleID).html();
				if (dataTypeExampleHTML !== "") {
					exampleHTML = dataTypeExampleHTML.replace(/%ROW%/g, rowID);
				} else {
					exampleHTML = "&nbsp;" + L.no_examples_available;
				}
				$("#gdColExamples_" + rowID).html(exampleHTML);

				var dataTypeOptionHTML = $("#gdDataTypeOptions_" + dataTypeModuleID).html();
				if (dataTypeOptionHTML !== "") {
					optionsHTML = dataTypeOptionHTML.replace(/%ROW%/g, rowID);
				} else {
					optionsHTML = L.no_options_available;
				}
				$("#gdColOptions_" + rowID).html(optionsHTML);

				if ($("#gdDataTypeHelp_" + dataTypeModuleID).html() !== "") {
					$('#gdColHelp_' + rowID).html($("#gdHelpIcon").html().replace(/%ROW%/g, rowID));
				} else {
					$('#gdColHelp_' + rowID).html(" ");
				}
			},
			isComplete: readyTest
		});

		Queue.process({ context: "dataTypeChange: " + dataTypeModuleID });
*/

	};


	var _getRowOrder = function() {
		var orderedRowIDs = $("#gdTableRows").sortable("toArray");
		var sortedOrder = [];
		for (var i=0; i<orderedRowIDs.length; i++) {
			var row = orderedRowIDs[i].replace(/row_/g, "");
			sortedOrder.push(row);
		}
		return sortedOrder;
	};


	/**
	 * Called when the user submits the main Generate tab. It performs all necessary validation
	 * and starts the data generation process.
	 */
	var _generateData = function() {
		_numRowsToGenerate = _getNumRowsToGenerate();
		utils.clearValidationErrors($("#gdTab1Content"));

		// check the users specified a numeric value for the number of results
		if (_numRowsToGenerate.match(/\D/) || _numRowsToGenerate === 0 || _numRowsToGenerate === "") {
			utils.addValidationErrors({ el: $("#gdNumRowsToGenerate"), error: L.invalid_num_results });
		}

		var orderedRowIDs = _getRowOrder();
		var validRowIDs = [];

		// look through the form and construct an object of data-type-folder => [row IDs] to
		// pass to the manager. The manager uses that to farm out the actual validation work
		// to the appropriate module
		var rowValidationNeededGroupByDataType = {};
		for (var i=0; i<orderedRowIDs.length; i++) {
			var rowID = orderedRowIDs[i];
			var currRowType = $("#gdDataType_" + rowID).val();

			// ignore empty rows, they don't need validating
			if (currRowType === "") {
				continue;
			}
			if (!rowValidationNeededGroupByDataType.hasOwnProperty(currRowType)) {
				rowValidationNeededGroupByDataType[currRowType] = [];
			}
			rowValidationNeededGroupByDataType[currRowType].push(rowID);
			validRowIDs.push(rowID);
		}

		// if none of the data columns had a selected data type, display an error about that, too
		if (!validRowIDs.length) {
			utils.addValidationErrors({ els: null, error: L.no_data });
		} else {
			// check all filled-in rows contained something in the first column
			var rowsMissingTitleEls = [];
			for (var j=0; j<validRowIDs.length; j++) {
				var currRowID = validRowIDs[j];
				var currTitle = $("#gdTitle_" + currRowID);
				if ($.trim(currTitle.val()) === "") {
					rowsMissingTitleEls.push(currTitle[0]);
				}
			}

			if (rowsMissingTitleEls.length) {
				var label = L.row_label_plural;
				if (L.exportTypePlugins[_currExportType].hasOwnProperty("row_label_plural")) {
					label = L.exportTypePlugins[_currExportType].row_label_plural;
				}
				var message = "Please enter all " + label + ".";
				utils.addValidationErrors({ els: rowsMissingTitleEls, error: message });
			}
		}

		utils.addValidationErrors(manager.validateDataTypes(rowValidationNeededGroupByDataType));

		var exportTypeValidationErrors = manager.validateExportType({ exportType: _currExportType, rows: validRowIDs });
		if (!$.isArray(exportTypeValidationErrors)) {
			utils.addValidationErrors({ els: null, error: "Ack! There was an error in the Export Type's validate() function. Sorry, we can't proceed - call a developer!" });
		} else {
			utils.addValidationErrors(exportTypeValidationErrors);
		}

		var errors = utils.getValidationErrors();
		if (errors.length) {
			utils.displayValidationErrors("#gdMessages");
			return false;
		}


		// ensure this is a number (now it's passed validation above)
		_numRowsToGenerate = parseInt(_numRowsToGenerate, 10);

		var exportTarget = _getExportTarget();
		var rowOrder = _getRowOrder().toString();
		$("#gdRowOrder").val(rowOrder);
		$("#gdExportType").val(_currExportType);
		$("#gdNumCols").val(_numRows);

		// reset CodeMirror (scrollTo not working ...)
		_codeMirror.setOption("lineWrapping", false);
		_codeMirror.scrollTo(0, 0);
		_codeMirror.setValue("");

		// now pass off the work to the appropriate generation function. Each works slightly differently.
		manager.publish({
			sender: MODULE_ID,
			type: C.EVENT.GENERATE,
			exportTarget: exportTarget,
			exportType: _currExportType,
			editor: _codeMirror
		});

		// if the messages section is displayed, hide it - whatever old errors are no longer pertinent
		if ($("#gdMessages").css("display") == "block") {
			$("#gdMessages .gdMessageClose").trigger("click");
		}

		if (exportTarget == "inPage") {
			_generateInPage();
			return false;
		} else if (exportTarget == "newTab") {
			_generateNewWindow();
		} else if (exportTarget == "promptDownload") {
			_generatePromptDownload();
		}
	};


	/**
	 * Generate the results in-page. This option hides the generator table and displays the results in a large,
	 * CodeMirror-enhanced textarea. This is the only generation format that makes use of *batches*: since generation
	 * can take a long time, this passes off work to the server in batches of (say) 100, so the user can see the
	 * generation process take place.
	 */
	var _generateInPage = function() {
		var formData = $("#gdData").serialize();

		// "action" added for AjaxRequest only
		var data = formData + "&action=generateInPage&gdBatchSize=" + C.GENERATE_IN_PAGE_BATCH_SIZE;
		if (_currConfigurationID !== null) {
			data += "&configurationID=" + _currConfigurationID;
		}
		_showSubtab(2);

		_generateInPageRunningCount = 0;
		_isGenerating = true;
		_generationCancelled = false;

		$("#gdGenerateCount").html(utils.formatNumWithCommas(_generateInPageRunningCount));
		$("#gdGenerateTotal").html(utils.formatNumWithCommas(_numRowsToGenerate));
		$("#gdProgressMeter").attr("max", _numRowsToGenerate);
		$("#gdProgressMeter").attr("value", 0);

		_generateInPageBatchNum = 1;
		_generateInPageData = data;
		_generateInPageContent = "";
		_generateInPageBatch();
	};

	var _generateInPageBatch = function() {
		$("#gdGenerationPanelCancel").removeClass("gdDisabledLink");
		var data = _generateInPageData + "&gdCurrentBatchNum=" + _generateInPageBatchNum;
		if (_currConfigurationID !== null) {
			data += "&configurationID=" + _currConfigurationID;
		}
		$.ajax({
			url: "ajax.php",
			type: "POST",
			data: data,
			dataType: "json",
			success: _generateInPageBatchResponse,
			error: function(response) {
				_isGenerating = false;
				console.log("error response: ", response);
			}
		});
	};

	var _generateInPageBatchResponse = function(response) {
		if (response.success) {
			// 1. Update the running count ("Generated X of Y rows")
			_generateInPageRunningCount = (_generateInPageRunningCount + C.GENERATE_IN_PAGE_BATCH_SIZE) > _numRowsToGenerate ?
				_numRowsToGenerate : _generateInPageRunningCount + C.GENERATE_IN_PAGE_BATCH_SIZE;
			$("#gdGenerateCount").html(utils.formatNumWithCommas(_generateInPageRunningCount));
			$("#gdProgressMeter").attr("value", _generateInPageRunningCount);

			// 2. Update the actual content
			_generateInPageContent += response.content;
			_codeMirror.setValue(_generateInPageContent);

			// check the process hasn't been interrupted
			if (_generationCancelled) {
				_isGenerating = false;
				$("#gdGenerationPanelCancel").addClass("gdDisabledLink");
				$("#gdProgressMeter").attr("value", _numRowsToGenerate);
				return;
			}

			// now either continue processing, or indicate we're done
			if (response.isComplete) {
				_isGenerating = false;
				$("#gdGenerationPanelCancel").addClass("gdDisabledLink");

				// update the data in _dataSets
				if (_currConfigurationID !== null) {
					_incrementConfigurationRowGenerationCount(_currConfigurationID, _numRowsToGenerate);
				}
			} else {
				_generateInPageBatchNum++;
				_generateInPageBatch();
			}
		} else {
			_isGenerating = false;
			console.warn("response.success fail");
		}
	};

	var _incrementConfigurationRowGenerationCount = function(configurationID, numRows) {
		// first, update the actual data set
		var updatedDataSets = [];
		var newNum = "";
		for (var i=0; i<_dataSets.length; i++) {
			if (_dataSets[i].configuration_id == configurationID) {
				var currCount = parseInt(_dataSets[i].num_rows_generated, 10);
				newNum = currCount + numRows;
				_dataSets[i].num_rows_generated = newNum;
			}
		}


		// second, update the displayed data. This does surgery on the Data Sets tab to just update the one DOM
		// element rather than redraw everything
		var rows = $("#gdAccountDataSets tbody tr");
		for (var j=0; j<rows.length; j++) {
			if ($(rows[j]).data("id") == configurationID) {
				$(rows[j]).find(".gdDataSetNumRowsGenerated").html(utils.formatNumWithCommas(newNum));
			}
		}

		// this updates the account info tab "total" count
		_updateAccountInfoTab();
	};

	var _generateNewWindow = function() {
		$("#gdData").attr({
			"target": "blank",
			"action": "generate.php"
		});
	};

	var _generatePromptDownload = function() {
		$("#gdData").attr({
			"target": "blank",
			"action": "generate.php"
		});
	};

	var _resetPluginsDialog = function() {
		$("#gdPluginInstallation").dialog({
			modal:     true,
			resizable: true,
			title:     "Reset Plugins",
			width:     800,
			height:    400,
			open: function() {
				pluginManager.installPlugins({
					errorHandler: null,
					onCompleteHandler: function() {
						$("#gdPluginInstallation").dialog("option", "buttons", [
							{
								text: "Refresh Page",
								click: function() {
									window.location.reload(true); // window.location.replace("index.php?message=plugins_reset#t3");
								}
							}
						]);
					}
				});
			},
			buttons: [
				{
					text: "Close",
					click: function() {
						$(this).dialog("close");
					}
				}
			]
		});
		return false;
	};


	var _changeTextSize = function(e) {
		$("#gdTextSize li").removeClass("gdSelected");
		var size = $(e.target).attr("class");
		$(e.target).addClass("gdSelected");
		$("#gdGenerateSubtab2 .CodeMirror").removeClass("CodeMirror_small CodeMirror_medium CodeMirror_large").addClass("CodeMirror_" + size);
		_codeMirror.refresh();
	};

	/**
	 * Called on page load. We always instantiate the codemirror object on the generate in-page. This object is
	 * passed in the C.EVENT.GENERATE message for export types to mess with (i.e. change the mode).
	 */
	var _initInPageCodeMirror = function() {
		_codeMirror = CodeMirror.fromTextArea($("#gdGeneratedData")[0], {
			mode: "xml",
			readOnly: true,
			lineNumbers: true
		});
		$(".CodeMirror").addClass("CodeMirror_medium");
	};

	var _getExportTarget = function() {
		return $("input[name=gdExportTarget]").val();
	};

	var _getNumRowsToGenerate = function() {
		return $("#gdNumRowsToGenerate").val();
	};

	var _getVisibleRowOrderByRowNum = function(rowNum) {
		var rowOrder = _getRowOrder();
		var visibleRowNum = 1;
		for (var i=0; i<rowOrder.length; i++) {
			if (rowOrder[i] == rowNum) {
				return visibleRowNum;
			}
			visibleRowNum++;
		}
		return false;
	};


	// main dialog

	var _initMainDialog = function() {
		$("#gdMainDialogTabs ul li").each(function() {
			var newTab = parseInt($(this).attr("id").replace(/^gdMainDialogTab/, ""), 10);
			$(this).bind("click", function() {
				utils.selectTab({ tabGroup: "dialogTabs", tabIDPrefix: "gdMainDialogTab", newTab: newTab, oldTab: _currHelpDialogTab } );
				_currHelpDialogTab = newTab;

				// if the user just clicked into the Data Type help tab, ensure the first Data Type listed is selected
				if (newTab == 3 && _currDataTypeHelp === null) {
					var dataTypeItems = $("#gdDataSetHelpNav li").not(".gdDataTypeHeader");
					_showDataTypeHelp(dataTypeItems[0]);
				}
			});
		});
	};

	var _onclickDataTypeHelpNav = function(e) {
		e.preventDefault();
		var dataTypeNavItem = $(e.target).closest("li");
		_showDataTypeHelp(dataTypeNavItem);
	};

	var _showDataTypeHelp = function(el) {
		var dataType = $(el).data("module");
		var link = $(el).find("a");

		$("#gdDataSetHelpNav a").removeClass("gdSelected");
		$(link).addClass("gdSelected");

		// set the header to the name of the Data Type
		$("#gdFocusedDataTypeHeader").html($(link).html());

		if (_currDataTypeHelp !== null) {
			$("#gdDataTypeHelp_" + _currDataTypeHelp).addClass("hidden");
		}
		$("#gdDataTypeHelp_" + dataType).removeClass("hidden");
		_currDataTypeHelp = dataType;
	};


	var _onClickDataSetRowHelp = function(e) {
		var row = $(e.target).closest(".gdTableRow");
		var dataTypeDropdown = row.find(".gdDataType");
		var choice = dataTypeDropdown.val();

		_openMainDialog({ tab: 3, dataType: choice });

		manager.publish({
			sender: MODULE_ID,
			type: C.EVENT.DATA_TABLE.ROW.HELP_DIALOG_OPEN,
			rowElement: row
		});
	};


	var _openMainDialog = function(settings) {
		var opts = $.extend({
			tab: 1,
			dataType: null
		}, settings);

		// hide/show the appropriate tab
		$("#gdMainDialogTab" + opts.tab).trigger("click");

		// remove any custom styles
		$(".gdHelpSection").removeAttr("style");

		// if required, ensure the appropriate Data Type item is selected
		if (opts.dataType !== null) {
			var helpNavEl = ($("#gdDataSetHelpNav li[data-module='" + opts.dataType + "']"))[0];
			_showDataTypeHelp(helpNavEl);
		}

		// open the dialog
		$("#gdMainDialog").dialog({
			title: "generatedata.com",
			width: 800,
			minHeight: 400,
			modal: true,
			resizable: false,
			buttons: [
				{
					text: "Close",
					click: function() { $(this).dialog("close"); }
				}
			]
		});

		return false;
	};

	var _closeMainDialog = function() {
		$("#gdMainDialog").dialog("close");
	};

	var _onChangeMarkDataSetRowToDelete = function(e) {
		var el = e.target;
		_markDataSetRowToDelete(el);
	};

	var _onClickToggleDeleteRow = function(e) {
		if ($.inArray(e.target.nodeName.toUpperCase(), ["INPUT", "A"]) !== -1) {
			return;
		}

		// reverse the checked-ness of the row
		var el = $(e.target).closest("tr").find(".gdDeleteDataSets");
		var isChecked = $(e.target).closest("tr").find(".gdDeleteDataSets").attr("checked");
		if (isChecked) {
			$(el).removeAttr("checked");
		} else {
			$(e.target).closest("tr").find(".gdDeleteDataSets").attr("checked", "checked");
		}

		_markDataSetRowToDelete(el[0]);
	};

	var _markDataSetRowToDelete = function(el) {
		if (el.checked) {
			$(el).closest("tr").addClass("gdDeletedDataSetRow").effect("highlight", { color: "#cc0000" }, 1000);
		} else {
			$(el).closest("tr").removeClass("gdDeletedDataSetRow");
		}
		_toggleDeleteDataSetButton();
	};

	var _onToggleSelectAllDataSets = function(e) {
		var isChecked = e.target.checked;
		var cbs = $("#gdAccountDataSets tbody input");
		for (var i=0; i<cbs.length; i++) {
			cbs[i].checked = isChecked;
		}
		_toggleDeleteDataSetButton();
	};

	var _confirmDeleteDataSets = function() {

	};

	/**
	 * Called whenever one or more rows is selected / unselected. This checks to see how
	 * many rows are selected, and hides/shows a delete button.
	 */
	var _toggleDeleteDataSetButton = function() {
		var cbs = $("#gdAccountDataSets tbody input:checked");
		if (cbs.length) {
			$("#gdMainDialog").dialog("option", "buttons", [
				{
					text: "Delete " + cbs.length + " Data Set(s)",
					"class": "gdDeleteDataSetsBtn",
					click: function() {
						_onClickDeleteDataSets();
					}
				},
				{
					text: "Close",
					click: function() { $(this).dialog("close"); }
				}
			]);
		} else {
			$("#gdMainDialog").dialog("option", "buttons", [
				{
					text: "Close",
					click: function() { $(this).dialog("close"); }
				}
			]);
		}
	};

	var _onClickDeleteDataSets = function() {
		// get the configuration IDs of the selected rows
		var configurationIDs = [];
		var cbs = $("#gdAccountDataSets tbody input:checked");
		for (var i=0; i<cbs.length; i++) {
			configurationIDs.push($(cbs[i]).closest("tr").data("id"));
		}

		$.ajax({
			url: "ajax.php",
			type: "POST",
			dataType: "JSON",
			data: {
				action: "deleteDataSets",
				configurationIDs: configurationIDs
			},
			success: _onSuccessDeleteDataSets,
			error: _onError
		});
	};


	var _onSuccessDeleteDataSets = function(response) {

		// if the delete was successful
		if (response.success) {

			// update the first tab (Num Saved Data Sets)
			var deletedConfigurationIDs = response.content;

			// var _accountInfo = null;
			// var _dataSets = [];
			var remainingDataSets = [];
			for (var i=0; i<_dataSets.length; i++) {
				if ($.inArray(_dataSets[i].configuration_id, response.content) == -1) {
					remainingDataSets.push(_dataSets[i]);
				}
			}
			_dataSets = remainingDataSets;
			$("#gdAccount_NumSavedDataSets").html(_dataSets.length);

			_displayDataSets();
			_toggleDeleteDataSetButton();
		}
	};


	// account-related

	var _getAccount = function() {
		utils.startProcessing();
		$.ajax({
			url: "ajax.php",
			type: "POST",
			dataType: "JSON",
			data: {
				action: "getAccount"
			},
			success: _onRetrievingAccountInfo,
			error: _onError
		});
	};

	var _onRetrievingAccountInfo = function(response) {
		utils.stopProcessing();

		// enable the save, load and link icons
		$("#gdActionIcons .loading").removeClass("loading");

		_isLoaded = true;
		_dataSets = response.content.configurations;
		_accountInfo = response.content;

		// remove configurations from the account Info object. This is just to prevent someone (like me) accidentally using
		// that data in that object, and not in _dataSets.
		delete _accountInfo.configurations;

		_updateAccountInfoTab();
		_displayDataSets();
	};


	var _updateAccountInfoTab = function() {
		if (_accountInfo.isAnonymous) {
			$("#gdAccount_AccountType").html("Anonymous admin account");
		} else {

		}

		$("#gdAccount_NumSavedDataSets").html(_dataSets.length);
		$("#gdAccount_DateAccountCreated").html(moment.unix(_accountInfo.dateCreated).format("MMM Do, YYYY"));

		var totalRowsGenerated = 0;
		for (var i=0; i<_dataSets.length; i++) {
			totalRowsGenerated += parseInt(_dataSets[i].num_rows_generated, 10);
		}
		$("#gdAccount_TotalRowsGenerated").html(utils.formatNumWithCommas(totalRowsGenerated));
	};

	var _displayDataSets = function() {
		if (_dataSets.length) {
			$("#gdNoAccountDataSets").addClass("hidden");
			var html = "";
			var row = "";
			var currDataSet;
			for (var i=0; i<_dataSets.length; i++) {
				currDataSet = _dataSets[i];
				var dateCreated = moment.unix(currDataSet.date_created_unix).format("MMM Do, YYYY");
				var lastUpdated = moment.unix(currDataSet.last_updated_unix).format("MMM Do, YYYY");

				row = '<tr data-id="' + currDataSet.configuration_id + '">' +
					'<td class="leftAligned">' + currDataSet.configuration_name + '</td>' +
					'<td class="leftAligned">' + dateCreated + '</td>' +
					'<td class="leftAligned">' + lastUpdated + '</td>' +
					'<td class="gdDataSetNumRowsGenerated" align="center">' + utils.formatNumWithCommas(currDataSet.num_rows_generated) + '</td>' +
					'<td align="center"><a href="#">load</a></td>' +
					'<td align="center"><input type="checkbox" class="gdDeleteDataSets" value="' + currDataSet.configuration_id + '"/></td>' +
					'</tr>';
				html += row;
			}
			$("#gdAccountDataSets tbody").html(html);
			$("#gdAccountDataSets").removeClass("hidden");
		} else {
			$("#gdAccountDataSets tbody").html("");
			$("#gdNoAccountDataSets").removeClass("hidden");
			$("#gdAccountDataSets").addClass("hidden");
		}
	};

	var _onError = function(response) {
		console.log("on error");
		console.log(response);
	};


	var _getConfiguration = function(configurationID) {
		var dataSet = {};
		for (var i=0; i<_dataSets.length; i++) {
			if (_dataSets[i].configuration_id != configurationID) {
				continue;
			}
			dataSet = _dataSets[i];
		}
		return dataSet;
	};


	var _initTooltips = function() {
		$(document).tooltip({
            position: {
                my: "center bottom-6",
                at: "center top"
            }
        });
	};

	var _cancelGeneration = function(e) {
		e.preventDefault();

		if ($(e.target).hasClass("gdDisabledLink")) {
			return;
		}

		if (!_isGenerating) {
			return;
		}
		_generationCancelled = true;
	};

	var _onClickBackButton = function(e) {
		e.preventDefault();
		_showSubtab(1);

		// if the user was in the process of generating a data set, cancel it
		if (_isGenerating) {
			_generationCancelled = true;
		}
	};

	// register our module
	manager.registerCoreModule(MODULE_ID, {
		run: _run,
		skipDomReady: false
	});


	/*
	 * The public API for this module. These are the only revealed functions for use by other modules
	 * that choose to include generator.js as a dependency. Even though the bulk of the functions are private,
	 * it still contains a couple of handy methods.
	 */
	return {

		/**
		 * Returns an ordered array of row IDs. Row IDs are unique and may be in any order with possible gaps. Each
		 * row is added dynamically, and may be sorted or deleted.
         * @function
         * @name Generator#getRowOrder
         */
		getRowOrder: _getRowOrder,

		/**
		 * When a user re-orders or deletes some rows, the table gives the appearance of being numbered
		 * numerically 1-N, however the actual markup retains the original number scheme according to how it
		 * was first generated. This function returns the visible number of the row number, used for generating
		 * helpful error messages.
         * @function
         * @param {Number} rowNum a row number. Returns false if there's no corresponding visible row number.
         * @name Generator#getVisibleRowOrderByRowNum
		 */
		getVisibleRowOrderByRowNum: _getVisibleRowOrderByRowNum,

		/**
		 * Returns an array of selected countries.
		 * @function
		 * @name Generator#getCountries
		 */
		getCountries: function() {
			return _countries;
		},

		/**
		 * Returns the current export target (new window, prompt, in-page).
		 * @function
		 * @name Generator#getExportTarget
		 */
		getExportTarget: _getExportTarget,

		/**
		 * Returns the number of rows to generate currently entered. Note: this returns a STRING.
		 * @function
		 * @name Generator#getNumRowsToGenerate
		 */
		getNumRowsToGenerate: _getNumRowsToGenerate
	};
});