var Mode = {SEGMENT:'segment',LINES:'lines',TEXT:'text'}
var PageStatus = {TODO:'statusTodo',SESSIONSAVED:'statusSession',SERVERSAVED:'statusServer',UNSAVED:'statusUnsaved'}
var ElementType = {SEGMENT:'segment',REGION:'region',TEXTLINE:'textline',CUT:'cut',CONTOUR:'contour'}

function Controller(bookID, canvasID, regionColors, colors, globalSettings) {
	const _actionController = new ActionController(this);
	const _communicator = new Communicator();
	const _colors = new Colors(colors,regionColors);
	this.textlineRegister = {};
	let _mode = Mode.SEGMENT;
	let _selector;
	let _gui;
	let _guiInput;
	let _navigationController;
	let _editor;
	let _currentPage;
	let _segmentedPages = [];
	let _savedPages = [];
	let _book;
	let _segmentation = {};
	let _settings;
	let _contours = {};
	let _presentRegions = [];
	let _tempID = null;
	let _allowLoadLocal = true;
	let _autoSegment = true;
	let _visibleRegions = {}; // !_visibleRegions.contains(x) and _visibleRegions[x] == false => x is hidden
	let _fixedSegments = {};
	let _editReadingOrder = false;

	let _newPolygonCounter = 0;

	// main method
	$(window).ready(() => {
		// Init PaperJS
		paper.setup(document.getElementById(canvasID));

		//set height before data is loaded //TODO rework
		$canvas = $("canvas");
		$sidebars = $('.sidebar');
		const height = $(window).height() - $canvas.offset().top;
		$canvas.height(height);
		$sidebars.height(height);

		_currentPage = 0;
		this.showPreloader(true);
		_communicator.loadBook(bookID, _currentPage).done((data) => {
			_book = data.book;
			_settings = data.settings;

			const regions = _settings.regions;
			Object.keys(regions).forEach((key) => {
				const region = regions[key];

				if (region.type !== 'ignore' && $.inArray(region.type, _presentRegions) < 0) {
					_presentRegions.push(region.type);
				}
			});
			// Init the viewer
			const viewerInput = new ViewerInput(this);

			// Inheritance Editor extends Viewer
			_editor = new Editor(viewerInput, _colors, this);

			_selector = new Selector(_editor, this);
			viewerInput.selector = _selector;
			_gui = new GUI(canvasID, _editor,_colors);
			_gui.resizeViewerHeight();

			_gui.setParameters(_settings.parameters, _settings.imageSegType, _settings.combine);
			_gui.loadVisiblePreviewImages();
			_gui.highlightSegmentedPages(_segmentedPages);

			_gui.setPageXMLVersion("2017-07-15");

			_gui.createSelectColors();
			_gui.updateAvailableColors();
			_gui.addPreviewImageListener();
			_communicator.getVirtualKeyboard().done((keyboard) => {
				_gui.setVirtualKeyboard(keyboard);
			});

			_navigationController = new NavigationController(_gui,_editor,this.getMode);
			viewerInput.navigationController = _navigationController;
			// setup paper again because of pre-resize bug
			// (streched)
			paper.setup(document.getElementById(canvasID));


			// Init inputs
			const keyInput = new KeyInput(_navigationController, this, _gui, _selector, ["#"+canvasID,"#textline-content"]);
			$(".sidebar").find("input").focusin(() => keyInput.isActive = false);
			$(".sidebar").find("input").focusout(() => keyInput.isActive = true);
			_guiInput = new GuiInput(_navigationController, this, _gui);

			this.showPreloader(false);
			this.displayPage(0);

			// on resize
			$(window).resize(() => {
				_gui.resizeViewerHeight();
				if(_mode == Mode.TEXT && _gui.isTextLineContentActive()){
					_gui.placeTextLineContent();
				}
			});


			// init Search
			$(document).ready(function(){
				let pageData = {};
				_book.pages.forEach(page => pageData[page.image] = null );
			});

			this.setMode(_mode);
		});
	});

	this.displayPage = function (pageNr) {
		this.escape();
		_currentPage = pageNr;

		this.showPreloader(true);

		// Check if page is to be segmented or if segmentation can be loaded
		if (_segmentedPages.indexOf(_currentPage) < 0 && _savedPages.indexOf(_currentPage) < 0) {
			if(_autoSegment){
				this.requestSegmentation(_allowLoadLocal);
			} else {
				if(!_allowLoadLocal){
					this._requestEmptySegmentation();
				}else{
					// Check if pages has local segmentation only if autoSegment is not allowed
					_communicator.getSegmented(_book.id).done((pages) =>{
						hasLocal = pages.includes(pageNr);
						pages.forEach(page => { _gui.addPageStatus(page,PageStatus.SERVERSAVED)});
						if(_allowLoadLocal && hasLocal){
							this.requestSegmentation(_allowLoadLocal);
						} else {
							this._requestEmptySegmentation();
						}
					});
				}
			}
		} else {
			const imageId = _book.pages[_currentPage].id + "image";
			// Check if image is loadedreadingOrder
			const image = $('#' + imageId);
			if (!image[0]) {
				_communicator.loadImage(_book.pages[_currentPage].image, imageId).done(() => this.displayPage(pageNr));
				return false;
			}
			if (!image[0].complete) {
				// break until image is loaded
				image.load(() => this.displayPage(pageNr));
				return false;
			}

			_editor.clear();
			_editor.setImage(imageId);

			const pageSegments = _segmentation[_currentPage] ? _segmentation[_currentPage].segments : null;

			this.textlineRegister = {};
			if (pageSegments) {
				// Iterate over Segment-"Map" (Object in JS)
				Object.keys(pageSegments).forEach((key) => {
					const pageSegment = pageSegments[key];
					_editor.addSegment(pageSegment, this.isSegmentFixed(key));
					if(pageSegment.textlines !== null){
						Object.keys(pageSegment.textlines).forEach((linekey) => {
							const textLine = pageSegment.textlines[linekey];
							textLine.type = "TextLine";
							_editor.addTextLine(textLine);
							this.textlineRegister[textLine.id] = pageSegment.id;
						});
					}
				});
			}

			const regions = _settings.regions;
			// Iterate over Regions-"Map" (Object in JS)
			Object.keys(regions).forEach((key) => {
				const region = regions[key];
				if(!_colors.hasColor(region.type));
					_colors.assignAvailableColor(region.type);

				// Iterate over all Polygons in Region
				Object.keys(region.polygons).forEach((polygonKey) => {
					let polygon = region.polygons[polygonKey];
					_editor.addRegion(polygon);

					if (!_visibleRegions[region.type] & region.type !== 'ignore') {
						_editor.hideSegment(polygon.id, true);
					}
				});

				if (region.type !== 'ignore' && $.inArray(region.type, _presentRegions) < 0) {
					//_presentRegions does not contains region.type
					_presentRegions.push(region.type);
				}
			});

			const pageCuts = _settings.pages[_currentPage].cuts;
			// Iterate over FixedSegment-"Map" (Object in JS)
			Object.keys(pageCuts).forEach((key) => _editor.addLine(pageCuts[key]));

			_navigationController.zoomFit();

			_gui.showUsedRegionLegends(_presentRegions);
			this.displayReadingOrder(false);
			_gui.updateRegionLegendColors(_presentRegions);

			_gui.selectPage(pageNr);
			this.endEditReadingOrder();
			this.showPreloader(false);

			// Open current Mode
			this.setMode(_mode);
		}
	}

	this.redo = function () {
		_actionController.redo(_currentPage);
	}
	this.undo = function () {
		_actionController.undo(_currentPage);
	}

	this.addPresentRegions = function (regionType) {
		if (regionType !== 'ignore' && $.inArray(regionType, _presentRegions) < 0) {
			//_presentRegions does not contains region.type
			_presentRegions.push(regionType);
		}
		_gui.showUsedRegionLegends(_presentRegions);
	}
	this.removePresentRegions = function (regionType) {
		_presentRegions = jQuery.grep(_presentRegions, (value) => value != regionType);
		_gui.showUsedRegionLegends(_presentRegions);
	}

	this.requestSegmentation = function (allowLoadLocal) {
		//Update setting parameters
		_settings.parameters = _gui.getParameters();

		//Add fixed Segments to settings
		const activesettings = JSON.parse(JSON.stringify(_settings));
		activesettings.pages[_currentPage].segments = {};
		if (!_fixedSegments[_currentPage]) _fixedSegments[_currentPage] = [];
		_fixedSegments[_currentPage].forEach(s => activesettings.pages[_currentPage].segments[s] = _segmentation[_currentPage].segments[s]);

		_communicator.segmentBook(activesettings, _currentPage, allowLoadLocal).done((result) => {
			const failedSegmentations = [];
			const missingRegions = [];

			_gui.highlightLoadedPage(_currentPage, false);
			switch (result.status) {
				case 'LOADED':
					_gui.highlightLoadedPage(_currentPage, true);
				case 'SUCCESS':
					_segmentation[_currentPage] = result;

					_actionController.resetActions(_currentPage);
					//check if all necessary regions are available
					Object.keys(result.segments).forEach((id) => {
						let segment = result.segments[id];
						if ($.inArray(segment.type, _presentRegions) == -1) {
							//TODO as Action
							this.changeRegionSettings(segment.type, 0, -1);
							if(!_colors.hasColor(segment.type)){
								_colors.assignAvailableColor(segment.type)
								const colorID = _colors.getColorID(segment.type);
								this.setRegionColor(segment.type,colorID);
							}
							missingRegions.push(segment.type);
						}
					});
					this.forceUpdateReadingOrder();
					break;
				default:
					failedSegmentations.push(_currentPage);
			}

			_segmentedPages.push(_currentPage);
			if (missingRegions.length > 0) {
				_gui.displayWarning('Warning: Some regions were missing and have been added.');
			}

			this.displayPage(_currentPage);
			_gui.highlightSegmentedPages(_segmentedPages);

			_communicator.getSegmented(_book.id).done((pages) =>{
				pages.forEach(page => { _gui.addPageStatus(page,PageStatus.SERVERSAVED)});
			})

		});
	}

	this.setMode = function(mode){
		_gui.setMode(mode);

		_mode = mode;
		if(mode === Mode.SEGMENT){
			_editor.displayOverlay("segments",true);
			_editor.displayOverlay("regions",true);
			_editor.displayOverlay("lines",false);
			if(_segmentation[_currentPage]){
				_gui.setReadingOrder(_segmentation[_currentPage].readingOrder,_segmentation[_currentPage].segments);
			}else{
				_gui.setReadingOrder([],{});
			}
			this.forceUpdateReadingOrder();
		} else if(mode === Mode.LINES){
			_editor.displayOverlay("segments",true);
			_editor.displayOverlay("regions",false);
			_editor.displayOverlay("lines",true);
			this.forceUpdateReadingOrder();
		} else if(mode === Mode.TEXT){
			_editor.displayOverlay("segments",false);
			_editor.displayOverlay("regions",false);
			_editor.displayOverlay("lines",true);
			this.displayReadingOrder(false);
		}
	}

	this.getMode = function(){
		return _mode;
	}

	this._requestEmptySegmentation = function () {
		_communicator.emptySegmentation(_book.id, _currentPage).done((result) => {
			_gui.highlightLoadedPage(_currentPage, false);
			_segmentation[_currentPage] = result;

			this.displayPage(_currentPage);
		});
		_segmentedPages.push(_currentPage);
	}

	this.uploadSegmentation = function (file) {

		this.showPreloader(true);

		_communicator.uploadPageXML(file, _currentPage, _book.id).done((page) => {
			const failedSegmentations = [];
			const missingRegions = [];

			switch (page.status) {
				case 'LOADED':
					_segmentation[_currentPage] = page;

					_actionController.resetActions(_currentPage);

					//check if all necessary regions are available
					Object.keys(page.segments).forEach((id) => {
						let segment = page.segments[id];
						if ($.inArray(segment.type, _presentRegions) == -1) {
							//TODO as Action
							this.changeRegionSettings(segment.type, 0, -1);
							const colorID = _colors.getColorID(segment.type);
							this.setRegionColor(segment.type,colorID);
							missingRegions.push(segment.type);
						}
					});
					this.forceUpdateReadingOrder();
					break;
				default:
					failedSegmentations.push(_currentPage);
			}

			_segmentedPages.push(_currentPage);
			if (missingRegions.length > 0) {
				_gui.displayWarning('Warning: Some regions were missing and have been added.');
			}

			this.displayPage(_currentPage);
			this.showPreloader(false);
			_gui.highlightSegmentedPages(_segmentedPages);
		});
	}

	this.exportPageXML = function () {
		_gui.setExportingInProgress(true);

		_communicator.exportSegmentation(_segmentation[_currentPage], _book.id, _gui.getPageXMLVersion()).done((data) => {
			// Set export finished
			_savedPages.push(_currentPage);
			_gui.setExportingInProgress(false);
			_gui.addPageStatus(_currentPage,PageStatus.SESSIONSAVED);

			// Download
			if (globalSettings.downloadPage) {
				var a = window.document.createElement('a');
				a.href = window.URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(data)], { type: "text/xml;charset=utf-8" }));
				const fileName = _book.pages[_currentPage].fileName;
				a.download = _book.name + "_" + fileName.substring(0, fileName.lastIndexOf(".")) + ".xml";

				// Append anchor to body.
				document.body.appendChild(a);
				a.click();
			}
		});
	}

	this.setChanged = function(pageID){
		_gui.addPageStatus(pageID,PageStatus.UNSAVED);
	}

	this.saveSettingsXML = function () {
		_gui.setSaveSettingsInProgress(true);
		_settings.parameters = _gui.getParameters();
		_communicator.exportSettings(_settings).done((data) => {
			var a = window.document.createElement('a');
			a.href = window.URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(data)], { type: "text/xml;charset=utf-8" }));
			a.download = "settings_" + _book.name + ".xml";

			// Append anchor to body.
			document.body.appendChild(a);
			a.click();

			// Remove anchor from body
			document.body.removeChild(a);

			_gui.setSaveSettingsInProgress(false);
		});
	}

	this.uploadSettings = function (file) {
		_communicator.uploadSettings(file, _book.id).done((settings) => {
			if (settings) {
				_settings = settings;
				_presentRegions = [];
				Object.keys(_settings.regions).forEach((regionType) => {
					if (regionType !== 'ignore') {
						_presentRegions.push(regionType);
					}
				});
				_gui.showUsedRegionLegends(_presentRegions);
				_gui.setParameters(_settings.parameters, _settings.imageSegType, _settings.combine);

				this.displayPage(_currentPage);
				this.hideAllRegions(true);
				_gui.forceUpdateRegionHide(_visibleRegions);
				_actionController.resetActions(_currentPage);
			}
		});
	}

	this.fixSegment = function (id, doFix = true) {
		if (!_fixedSegments[_currentPage]) _fixedSegments[_currentPage] = [];
		let arrayPosition = $.inArray(id, _fixedSegments[_currentPage]);
		if (doFix && arrayPosition < 0) {
			_fixedSegments[_currentPage].push(id)
		} else if (!doFix && arrayPosition > -1) {
			//remove from _fixedSegments
			_fixedSegments[_currentPage].splice(arrayPosition, 1);
		}
		_editor.fixSegment(id, doFix);
	}

	this.createSegmentPolygon = function () {
		this.endEditing();
		_editor.startCreatePolygon(ElementType.SEGMENT);
		_gui.selectToolBarButton('segmentPolygon', true);
	}
	this.createTextLinePolygon = function () {
		const selected = _selector.getSelectedSegments();
		if((_selector.selectedType === ElementType.SEGMENT || _selector.selectedType === ElementType.TEXTLINE)
				&& selected.length > 0 ){
			this.endEditing();
			_tempID = _selector.selectedType === ElementType.SEGMENT ? selected[0] : this.textlineRegister[selected[0]];
			// Check if segment region is a TextRegion
			if(this.isIDTextRegion(_tempID)){
				_editor.startCreatePolygon(ElementType.TEXTLINE);
				_gui.selectToolBarButton('textlinePolygon', true);
			}
		}else{
			_gui.displayWarning('Warning: Can only create TextLines if a TextRegion has been selected before hand.');
		}
	}
	this.createRectangle = function (type) {
		this.endEditing();

		// Check for TextLine
		if(type === ElementType.TEXTLINE ){
			const selected = _selector.getSelectedSegments();

			if(selected.length > 0 && 
				(_selector.selectedType === ElementType.SEGMENT && this.isIDTextRegion(selected[0])) ||
				(_selector.selectedType === ElementType.TEXTLINE && this.isIDTextRegion(this.textlineRegister[selected[0]]))) {

				_tempID = _selector.selectedType === ElementType.TEXTLINE ? this.textlineRegister[selected[0]] : selected[0];
			}else{
				_gui.displayWarning('Warning: Can only create TextLines if a TextRegion has been selected before hand.');
				return;
			}
		}
		_editor.createRectangle(type);
		switch (type) {
			case ElementType.SEGMENT:
				_gui.selectToolBarButton('segmentRectangle', true);
				break;
			case ElementType.REGION:
				_gui.selectToolBarButton('regionRectangle', true);
				break;
			case ElementType.TEXTLINE:
				_gui.selectToolBarButton('textlineRectangle', true);
				break;
			case 'ignore':
				_gui.selectToolBarButton('ignore', true);
				break;
			case 'roi':
				_gui.selectToolBarButton('roi', true);
				break;
		}
	}

	this.createCut = function () {
		this.endEditing();
		_editor.startCreateLine();
		_gui.selectToolBarButton(ElementType.CUT, true);
	}

	this.fixSelected = function () {
		if (_selector.selectedType === ElementType.SEGMENT) {
			const actions = [];
			const selected = _selector.getSelectedSegments();
			const selectType = _selector.getSelectedPolygonType();
			for (let i = 0, selectedlength = selected.length; i < selectedlength; i++) {
				if (selectType === ElementType.REGION) {
				} else if (selectType === ElementType.SEGMENT) {
					if (!_fixedSegments[_currentPage]) _fixedSegments[_currentPage] = [];
					let wasFixed = $.inArray(selected[i], _fixedSegments[_currentPage]) > -1;
					actions.push(new ActionFixSegment(selected[i], this, !wasFixed));
				} else if (selectType === ElementType.CUT) {
				}
			}
			let multiFix = new ActionMultiple(actions);
			_actionController.addAndExecuteAction(multiFix, _currentPage);
			selected.forEach(s => _selector.select(s));
		}
	}

	this.moveSelectedPoints = function () {
		const selected = _selector.getSelectedSegments();
		const selectType = _selector.getSelectedPolygonType();
		let points = _selector.getSelectedPoints();

		if (points && points.length > 0 && selected.length === 1 
			&& (selectType === ElementType.SEGMENT || selectType === ElementType.TEXTLINE)) {
			_editor.startMovePolygonPoints(selected[0], selectType, points);
		}
	}

	this.endEditing = function () {
		_editor.endEditing();
		this.displayContours(false);
		_gui.unselectAllToolBarButtons();
		_gui.closeTextLineContent();
	}

	this.deleteSelected = function () {
		const selected = _selector.getSelectedSegments();
		const points = _selector.getSelectedPoints();
		const selectType = _selector.getSelectedPolygonType();

		if (selected.length === 1 && points.length > 0) {
			// Points inside of a polygon is selected => Delete points
			if(selectType === ElementType.SEGMENT || selectType === ElementType.TEXTLINE){
				const segments = (selectType === ElementType.SEGMENT) ? 
							_segmentation[_currentPage].segments[selected[0]].points:
							_segmentation[_currentPage].segments[this.textlineRegister[selected[0]]].textlines[selected[0]].points;
				let filteredSegments = segments;

				points.forEach(p => { filteredSegments = filteredSegments.filter(s => !(s.x === p.x && s.y === p.y))});
				if(selectType === ElementType.SEGMENT)
					_actionController.addAndExecuteAction(new ActionTransformSegment(selected[0], filteredSegments, _editor, _segmentation, _currentPage, this), _currentPage);
				else
					_actionController.addAndExecuteAction(new ActionTransformTextLine(selected[0], filteredSegments, _editor, _segmentation, _currentPage, this), _currentPage);
			}
		}else{
			//Polygon is selected => Delete polygon
			const actions = [];
			for (let i = 0, selectedlength = selected.length; i < selectedlength; i++) {
				if (selectType === ElementType.REGION) {
					actions.push(new ActionRemoveRegion(this._getRegionByID(selected[i]), _editor, _settings, _currentPage, this));
				} else if (selectType === ElementType.SEGMENT) {
					let segment = _segmentation[_currentPage].segments[selected[i]];
					actions.push(new ActionRemoveSegment(segment, _editor, _segmentation, _currentPage, this));
				} else if (selectType === ElementType.CUT) {
					let cut = _settings.pages[_currentPage].cuts[selected[i]];
					actions.push(new ActionRemoveCut(cut, _editor, _settings, _currentPage));
				} else if (selectType === ElementType.TEXTLINE) {
					let segment = _segmentation[_currentPage].segments[this.textlineRegister[selected[i]]].textlines[selected[i]];
					actions.push(new ActionRemoveTextLine(segment, _editor, _segmentation, _currentPage, this));
				}
			}
			let multidelete = new ActionMultiple(actions);
			_actionController.addAndExecuteAction(multidelete, _currentPage);
		} 
	}

	this.mergeSelectedSegments = function () {
		const selected = _selector.getSelectedSegments();
		const selectType = _selector.getSelectedPolygonType();

		if(selected.length > 1 && (selectType === ElementType.SEGMENT || selectType === ElementType.TEXTLINE)){
			const actions = [];
			const segments = [];
			let parent = null;
			for (let i = 0, selectedlength = selected.length; i < selectedlength; i++) {
				let segment = null;
				if (selectType === ElementType.SEGMENT) {
					segment = _segmentation[_currentPage].segments[selected[i]];
				} else {
					segment = _segmentation[_currentPage].segments[this.textlineRegister[selected[i]]].textlines[selected[i]];
				}
				//filter special case image (do not merge images)
				if (segment.type !== 'ImageRegion') {
					segments.push(segment);
					if(_mode === Mode.SEGMENT){
						actions.push(new ActionRemoveSegment(segment, _editor, _segmentation, _currentPage, this));
					} else if(_mode === Mode.LINES){
						parent = !parent ? this.textlineRegister[segment.id] : parent;
						actions.push(new ActionRemoveTextLine(segment, _editor, _segmentation, _currentPage, this));
					}
				}
			}
			if (segments.length > 1) {
				_communicator.mergeSegments(segments, _currentPage, _book.id).done((data) => {
					const mergedSegment = data;
					if(mergedSegment.points.length > 1){
						if(_mode === Mode.SEGMENT){
						actions.push(new ActionAddSegment(mergedSegment.id, mergedSegment.points, mergedSegment.type,
							_editor, _segmentation, _currentPage, this));
						}else if(_mode === Mode.LINES){
						actions.push(new ActionAddTextLine(mergedSegment.id, parent, mergedSegment.points,
							{}, _editor, _segmentation, _currentPage, this));
						}

						let mergeAction = new ActionMultiple(actions);
						_actionController.addAndExecuteAction(mergeAction, _currentPage);
						this.selectSegment(mergedSegment.id);
						this.openContextMenu(true);
					} else {
						_gui.displayWarning("Combination of segments resulted in a segment with to few points. Segment will be ignored.");
					}
				});
			}
		} else if(selectType === ElementType.CONTOUR){
			const contours = selected.map(id => _contours[_currentPage][id]);
			const contourAccuracy = _gui.getParameters()['contourAccuracy'];
			_communicator.combineContours(contours,_currentPage,_book.id,contourAccuracy).done((segment) => {
				if(segment.points.length > 0){
					const action = new ActionAddSegment(segment.id, segment.points, segment.type,
						_editor, _segmentation, _currentPage, this);

					_actionController.addAndExecuteAction(action, _currentPage);
					_selector.unSelect();
					this.openContextMenu(true);
				} else {
					_gui.displayWarning("Combination of contours resulted in a segment with to few points. Segment will be ignored.");
				}
			});
		}
	}

	this.changeTypeSelected = function (newType) {
		const selected = _selector.getSelectedSegments();
		const selectType = _selector.getSelectedPolygonType();
		const selectedlength = selected.length;
		if (selectType === ElementType.REGION || selectType === ElementType.SEGMENT){
			if (selectedlength || selectedlength > 0) {
				const actions = [];
				for (let i = 0; i < selectedlength; i++) {
					if (selectType === ElementType.REGION) {
						const regionPolygon = this._getRegionByID(selected[i]);
						actions.push(new ActionChangeTypeRegionPolygon(regionPolygon, newType, _editor, _settings, _currentPage, this));

						this.hideRegion(newType, false);
					} else if (selectType === ElementType.SEGMENT) {
						actions.push(new ActionChangeTypeSegment(selected[i], newType, _editor, this, _segmentation, _currentPage, false));
					}
				}
				const multiChange = new ActionMultiple(actions);
				_actionController.addAndExecuteAction(multiChange, _currentPage);
			}
		}
	}
	this.createRegionBorder = function () {
		this.endEditing();
		_editor.startCreateBorder(ElementType.REGION);
		_gui.selectToolBarButton('regionBorder', true);
	}
	this.callbackNewRegion = function (regionpoints, regiontype) {
		const newID = "created" + _newPolygonCounter;
		_newPolygonCounter++;
		if (!regiontype) {
			type = _presentRegions[0];
			if (!type) {
				type = "other";
			}
		} else {
			type = regiontype;
		}

		const actionAdd = new ActionAddRegion(newID, regionpoints, type,
			_editor, _settings, _currentPage);

		_actionController.addAndExecuteAction(actionAdd, _currentPage);
		if (!regiontype) {
			this.openContextMenu(false, newID);
		}
		_gui.unselectAllToolBarButtons();
	}

	this.callbackNewRoI = function (regionpoints) {
		let left = 1;
		let right = 0;
		let top = 1;
		let down = 0;

		$.each(regionpoints, function (index, point) {
			if (point.x < left)
				left = point.x;
			if (point.x > right)
				right = point.x;
			if (point.y < top)
				top = point.y;
			if (point.y > down)
				down = point.y;
		});

		const actions = [];

		//Create 'inverted' ignore rectangle
		actions.push(new ActionAddRegion("created" + _newPolygonCounter, [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: top }, { x: 0, y: top }], 'ignore',
			_editor, _settings, _currentPage));
		_newPolygonCounter++;

		actions.push(new ActionAddRegion("created" + _newPolygonCounter, [{ x: 0, y: 0 }, { x: left, y: 0 }, { x: left, y: 1 }, { x: 0, y: 1 }], 'ignore',
			_editor, _settings, _currentPage));
		_newPolygonCounter++;

		actions.push(new ActionAddRegion("created" + _newPolygonCounter, [{ x: 0, y: down }, { x: 1, y: down }, { x: 1, y: 1 }, { x: 0, y: 1 }], 'ignore',
			_editor, _settings, _currentPage));
		_newPolygonCounter++;

		actions.push(new ActionAddRegion("created" + _newPolygonCounter, [{ x: right, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: right, y: 1 }], 'ignore',
			_editor, _settings, _currentPage));
		_newPolygonCounter++;

		_actionController.addAndExecuteAction(new ActionMultiple(actions), _currentPage);
		_gui.unselectAllToolBarButtons();
	}

	this.callbackNewSegment = function (segmentpoints) {
		const newID = "created" + _newPolygonCounter;
		_newPolygonCounter++;
		let type = _presentRegions[0];
		if (!type) {
			type = "other";
		}
		if(segmentpoints.length > 1){
			const actionAdd = new ActionAddSegment(newID, segmentpoints, type,
				_editor, _segmentation, _currentPage, this);

			_actionController.addAndExecuteAction(actionAdd, _currentPage);
			this.openContextMenu(false, newID);
		} else {
			_gui.displayWarning("The system tried to create an invalid segment with to few points. Segment will be ignored.")
		}
		_gui.unselectAllToolBarButtons();
	}

	this.callbackNewTextLine = function (segmentpoints) {
		const newID = "created" + _newPolygonCounter;
		_newPolygonCounter++;
		if(segmentpoints.length > 1){
			const actionAdd = new ActionAddTextLine(newID,_tempID, segmentpoints, {},
				_editor, _segmentation, _currentPage, this);

			_actionController.addAndExecuteAction(actionAdd, _currentPage);
			this.openContextMenu(false, newID);
		} else {
			_gui.displayWarning("The system tried to create an invalid textline with to few points. Segment will be ignored.")
		}
		_gui.unselectAllToolBarButtons();
	}

	this.callbackNewCut = function (segmentpoints) {
		const newID = "created" + _newPolygonCounter;
		_newPolygonCounter++;

		const actionAdd = new ActionAddCut(newID, segmentpoints,
			_editor, _settings, _currentPage);

		_actionController.addAndExecuteAction(actionAdd, _currentPage);
		_gui.unselectAllToolBarButtons();
	}

	this.movePolygonPoints = function (id, segmentPoints, type=this.getIDType(id)) {
		if(type === ElementType.SEGMENT || type === ElementType.TEXTLINE){
			this.transformSegment(id, segmentPoints, type);
			_selector.unSelect();
			_selector.select(id,segmentPoints);
		}
	}

	this.transformSegment = function (id, segmentPoints, type=this.getIDType(id)) {
		let action;
		switch(type){
			case ElementType.SEGMENT: 
				action = new ActionTransformSegment(id, segmentPoints, _editor, _segmentation, _currentPage, this);
				break;
			case ElementType.TEXTLINE:
				action =  new ActionTransformTextLine(id, segmentPoints, _editor, _segmentation, _currentPage, this);
				break;
			default:
		}
		if(action) {
			_actionController.addAndExecuteAction(action, _currentPage);
		}
	}

	this.scaleSelectedRegion = function () {
		_editor.endEditing();
		const selectType = _selector.getSelectedPolygonType();
		const selected = _selector.getSelectedSegments();

		if (selectType === ElementType.REGION && selected.length === 1) 
			_editor.startScalePolygon(selected[0], ElementType.REGION);
	}

	this.transformRegion = function (regionID, regionSegments) {
		const polygonType = this.getIDType(regionID);
		if (polygonType === ElementType.REGION) {
			let regionType = this._getRegionByID(regionID).type;
			let actionTransformRegion = new ActionTransformRegion(regionID, regionSegments, regionType, _editor, _settings, _currentPage, this);
			_actionController.addAndExecuteAction(actionTransformRegion, _currentPage);
			this.hideRegion(regionType, false);
			_selector.select(regionID);
		}
	}

	this.changeRegionType = function (id, type) {
		const polygonType = this.getIDType(id);
		if (polygonType === ElementType.REGION) {
			const regionPolygon = this._getRegionByID(id);
			if (regionPolygon.type != type) {
				let actionChangeType = new ActionChangeTypeRegionPolygon(regionPolygon, type, _editor, _settings, _currentPage, this);
				_actionController.addAndExecuteAction(actionChangeType, _currentPage);
			}
			this.hideRegion(type, false);
		} else if (polygonType === ElementType.SEGMENT) {
			if (_segmentation[_currentPage].segments[id].type != type) {
				const actionChangeType = new ActionChangeTypeSegment(id, type, _editor, this, _segmentation, _currentPage, false);
				_actionController.addAndExecuteAction(actionChangeType, _currentPage);
			}
		}
	}

	this.openRegionSettings = function (regionType) {
		if(regionType){
			let region = _settings.regions[regionType];
			if (!region) 
				region = _settings.regions['paragraph']; // If no settings exist, take the ones of paragraph
			if (!_colors.hasColor(regionType))
				_colors.assignAvailableColor(regionType);
			const colorID = _colors.getColorID(regionType);

			_gui.openRegionSettings(regionType, region.minSize, region.maxOccurances, colorID);
		}else{
			_gui.openRegionCreate();
		}
	}

	this.setRegionColor = function (regionType, colorID) {
		_colors.setColor(regionType, colorID);
		_gui.updateAvailableColors();

		const pageSegments = _segmentation[_currentPage].segments;
		Object.keys(pageSegments).forEach((key) => {
				let segment = pageSegments[key];
				if (segment.type === regionType) {
					_editor.updateSegment(segment);
				}
		});
		
		const region = _settings.regions[regionType];
		// Iterate over all Polygons in Region
		Object.keys(region.polygons).forEach((polygonKey) => {
			let polygon = region.polygons[polygonKey];
			if (polygon.type === regionType) {
				_editor.updateSegment(polygon);
			}
		});
		_gui.updateRegionLegendColors(_presentRegions);
	}

	/**
	 * Add all currently selected segments that can be added to the reading order (global or local) 
	 * to the reading order.
	 */
	this.addSelectedToReadingOrder = function(){
		const selected = _editor.getSortedReadingOrder(_selector.getSelectedSegments());
		const selectType = _selector.getSelectedPolygonType();

		const actions = [];
		for (let i = 0, selectedlength = selected.length; i < selectedlength; i++) {
			const id = selected[i];
			if (selectType === ElementType.SEGMENT && _mode === Mode.SEGMENT) {
				let segment = _segmentation[_currentPage].segments[id];

				if (!this._readingOrderContains(id) && segment.type !== 'ImageRegion'){
					actions.push(new ActionAddToReadingOrder(segment, _currentPage, _segmentation, this));
				}
			} else if (selectType === ElementType.TEXTLINE && _mode === Mode.LINES) {
				const parentID = this.textlineRegister[id];
				if (!this._readingOrderContains(id,parentID,selectType)){
					actions.push(new ActionAddTextLineToReadingOrder(id,parentID, _currentPage, _segmentation, this));
				}
			}
		}
		if(actions.length > 0){
			_actionController.addAndExecuteAction(new ActionMultiple(actions), _currentPage);
		}else{
			_gui.displayWarning("You need to select a segment to add to the reading order.");
		}
	}

	this.autoGenerateReadingOrder = function () {
		this.endEditReadingOrder();
		let readingOrder = [];
		const pageSegments = _segmentation[_currentPage].segments;

		// Iterate over Segment-"Map" (Object in JS)
		Object.keys(pageSegments).forEach((key) => {
			let segment = pageSegments[key];
			if (segment.type !== 'ImageRegion') {
				readingOrder.push(segment.id);
			}
		});
		readingOrder = _editor.getSortedReadingOrder(readingOrder);
		_actionController.addAndExecuteAction(new ActionChangeReadingOrder(_segmentation[_currentPage].readingOrder, readingOrder, this, _segmentation, _currentPage), _currentPage);
	}

	/**
	 * Toggle if the reading order can be edited by clicking on segments.
	 * (Left click will add to the reading order and right click will end the edit)
	 */
	this.toggleEditReadingOrder = function() {
		_editReadingOrder = !_editReadingOrder;
		_gui.selectToolBarButton('editReadingOrder', _editReadingOrder);
	}

	/** 
	 * End edit reading order 
	 */
	this.endEditReadingOrder = function(){
		_editReadingOrder = false;
		_gui.selectToolBarButton('editReadingOrder', _editReadingOrder);
	}

	/**
	 * Save the current reading order via an actions tate
	 */
	this.saveReadingOrder = function () {
		const tempReadingOrder = JSON.parse(JSON.stringify(_gui.getReadingOrder()));
		const action = new ActionChangeReadingOrder( _segmentation[_currentPage].readingOrder, tempReadingOrder, this, _segmentation, _currentPage);
		_actionController.addAndExecuteAction(action, _currentPage);
	}

	/**
	 * Delete the current complete reading order
	 */
	this.deleteReadingOrder = function () {
		const currentReadingOrder = _segmentation[_currentPage].readingOrder;
		if(currentReadingOrder && currentReadingOrder.length > 0){
			const action = new ActionChangeReadingOrder(currentReadingOrder, [], this, _segmentation, _currentPage);
			_actionController.addAndExecuteAction(action, _currentPage);
		}
	}

	/**
	 * Display/Hide the global reading order of a page (SEGMENT Mode) or
	 * the local text line reading order of a segment (TEXTLINE Mode).
	 */
	this.displayReadingOrder = function (doDisplay=true) {
		if(doDisplay){
			let readingOrder = []; // temp reading order either pointing to a global or local reading order
			if(_segmentation[_currentPage] !== null){
				if (_mode === Mode.SEGMENT) {
					// Display the normal reading order
					readingOrder = (_segmentation[_currentPage].readingOrder || [] );
					_gui.setReadingOrder(readingOrder, _segmentation[_currentPage].segments);

				} else if(_mode === Mode.LINES) {
					// Get TextRegion segment or parent of Textline, depending on selection
					const selected = _selector.getSelectedSegments();
					if(selected.length > 0){
						const selectedType = _selector.getSelectedPolygonType();
						// Retrieve TextRegion ID
						let segmentID; 
						if(selectedType === ElementType.SEGMENT){
							// Get segmentID of a selected TextRegion (paragraph etc.)
							segmentID = selected.filter(id => !_segmentation[_currentPage].segments[id].type.includes("Region"))[0];

						} else if(selectedType === ElementType.TEXTLINE){ 
							const parents = selected.map((id) => this.textlineRegister[id]).sort();
							// Create counter object for parents accurences
							const parents_counter = {}; 
							parents.forEach(p => {parents_counter[p] = (parents_counter[p] || 0) + 1}); 
							// Sort and retrieve most represented/dominant parent
							[segmentID,_] = [...Object.entries(parents_counter)].sort((a, b) => b[1] - a[1])[0];
						}
						const segment = _segmentation[_currentPage].segments[segmentID];
						readingOrder = (segment.readingOrder || []);
						_gui.setReadingOrder(readingOrder, segment.textlines);
					} else {
						_gui.setReadingOrder([], {});
					}
				} else {
					_gui.setReadingOrder([], {});
				}
			}
			_editor.displayReadingOrder(readingOrder);
		}else{
			_editor.hideReadingOrder();
		}
		_gui.displayReadingOrder(doDisplay);
	}

	this.forceUpdateReadingOrder = function (forceDisplay=false) {
		_gui.updateRegionLegendColors(_presentRegions);
		if (forceDisplay){
			this.displayReadingOrder(true);
			_gui.openReadingOrderSettings();
		}else{
			this.displayReadingOrder(_gui.isReadingOrderActive());
		}
	}

	/**
	 * Remove an element by its id from the reading order.
	 */
	this.removeFromReadingOrder = function (id) {
		switch(_mode){
			case Mode.SEGMENT:
				_actionController.addAndExecuteAction(new ActionRemoveFromReadingOrder(id, _currentPage, _segmentation, this), _currentPage);
				break;
			case Mode.LINES:
				_actionController.addAndExecuteAction(new ActionRemoveTextLineFromReadingOrder(id, this.textlineRegister[id], _currentPage, _segmentation, this), _currentPage);
				break;
		}
	}

	this.changeImageMode = function (imageMode) {
		_settings.imageSegType = imageMode;
	}

	this.changeImageCombine = function (doCombine) {
		_settings.combine = doCombine;
	}

	this.applyGrid = function () {
		_editor.addGrid();
	}

	this.removeGrid = function () {
		_editor.removeGrid();
	}

	this._readingOrderContains = function (id,parentID=this.textlineRegister[id],type=this.getIDType(id)) {
		const readingOrder = (type === ElementType.SEGMENT) ?
								_segmentation[_currentPage].readingOrder :
								_segmentation[_currentPage].segments[parentID].readingOrder;
		

		return readingOrder && readingOrder.includes(id);
	}
	// Display
	this.selectSegment = function (sectionID, hitTest, idType=this.getIDType(sectionID)) {
		if (_editReadingOrder && idType === ElementType.SEGMENT) {

			const segment = this._getPolygon(sectionID);
			if (!this._readingOrderContains(sectionID)) {
				_actionController.addAndExecuteAction(new ActionAddToReadingOrder(segment, _currentPage, _segmentation, this), _currentPage);
			}
		} else {
			let points;
			if (hitTest && hitTest.type == ElementType.SEGMENT) {
				const nearestPoint = hitTest.segment.point;
				points = [_editor._convertCanvasToGlobal(nearestPoint.x, nearestPoint.y)];
				_selector.select(sectionID, points);
			} else {
				_selector.select(sectionID, null, idType);
			}

			this.closeContextMenu();
		}
	}


	this.hasPointsSelected = function() {
		return (_selector.getSelectedPolygonType() === ElementType.SEGMENT || _selector.getSelectedPolygonType() === ElementType.TEXTLINE)
				&& _selector.getSelectedSegments().length === 1 
				&& _selector.getSelectedPoints().length > 0;
	}

	this.unSelect = function () {
		_selector.unSelect();
	}
	this.unSelectSegment = function (segmentID) {
		_selector.unSelectSegment(segmentID);
	}
	this.isSegmentSelected = function (id) {
		return _selector.isSegmentSelected(id);
	}
	this.highlightSegment = function (sectionID, doHighlight = true) {
		if(doHighlight){
			if (!_editor.isEditing) {
				if(_mode === Mode.SEGMENT || 
						(_mode === Mode.LINES && 
							(this.getIDType(sectionID) === ElementType.TEXTLINE || _selector.getSelectedSegments().length == 0))){
					_editor.highlightSegment(sectionID, doHighlight);
					_gui.highlightSegment(sectionID, doHighlight);
				}
			}
		}else{
			_editor.highlightSegment(sectionID, doHighlight);
			_gui.highlightSegment(sectionID, doHighlight);
		}
	}
	this.hideAllRegions = function (doHide) {
		// Iterate over Regions-"Map" (Object in JS)
		Object.keys(_settings.regions).forEach((key) => {
			const region = _settings.regions[key];
			if (region.type !== 'ignore') {
				// Iterate over all Polygons in Region
				Object.keys(region.polygons).forEach((polygonKey) => {
					let polygon = region.polygons[polygonKey];
					_editor.hideSegment(polygon.id, doHide);
				});

				_visibleRegions[region.type] = !doHide;
			}
		});
	}
	this.hideRegion = function (regionType, doHide) {
		_visibleRegions[regionType] = !doHide;

		const region = _settings.regions[regionType];
		// Iterate over all Polygons in Region
		Object.keys(region.polygons).forEach((polygonKey) => {
			let polygon = region.polygons[polygonKey];
			_editor.hideSegment(polygon.id, doHide);
		});
		_gui.forceUpdateRegionHide(_visibleRegions);
	}

	this.selectContour = function(id) {
		_selector.select(id, null, ElementType.CONTOUR);
	}

	this.displayContours = function(display=true) {
		_gui.displayContours(display);
		if(!display || _editor.mode == ViewerMode.CONTOUR){
			_editor.displayContours(false);
			_editor.mode = ViewerMode.POLYGON;
			_gui.selectToolBarButton('segmentContours',false);
		} else {
			_selector.unSelect();
			_gui.selectToolBarButton('segmentContours',true);
			if(!_contours[_currentPage]){
				this.showPreloader(true);
				_communicator.extractContours(_currentPage,_book.id).done((result) => {
					_contours[_currentPage] = result; 
					this.showPreloader(false);
					_editor.setContours(_contours[_currentPage]);
					_editor.displayContours();
					_editor.mode = ViewerMode.CONTOUR;
				});
			} else {
				_editor.setContours(_contours[_currentPage]);
				_editor.displayContours();
				_editor.mode = ViewerMode.CONTOUR;
			}
		}
	}

	this.editLine = function(id){
		if(this.getIDType(id) == ElementType.TEXTLINE){
			const textline = _segmentation[_currentPage].segments[this.textlineRegister[id]].textlines[id];
			_gui.openTextLineContent(textline);
		}
	}

	this.saveLine = function(){
		const textlinecontent = _gui.getTextLineContent();
		const id = textlinecontent.id;
		if(id && this.getIDType(id) == ElementType.TEXTLINE){
			const content = textlinecontent.text;
			_actionController.addAndExecuteAction(new ActionChangeTextLineText(id, content, _editor, _gui, _segmentation, _currentPage, this), _currentPage);
		}
	}

	this.changeRegionSettings = function (regionType, minSize, maxOccurances) {
		let region = _settings.regions[regionType];
		//create Region if not present
		if (!region) {
			region = {};
			region.type = regionType;
			region.polygons = {};
			_settings.regions[regionType] = region;
			_presentRegions.push(regionType);
			_gui.showUsedRegionLegends(_presentRegions);
		}
		region.minSize = minSize;
		region.maxOccurances = maxOccurances;
	}
	this.deleteRegionSettings = function (regionType) {
		if ($.inArray(regionType, _presentRegions) >= 0 && regionType != 'ImageRegion' && regionType != 'paragraph') {
			_actionController.addAndExecuteAction(new ActionRemoveCompleteRegion(regionType, this, _editor, _settings, this), _currentPage);
		}
	}
	this.showPreloader = function (doShow) {
		if (doShow) {
			$('#preloader').removeClass('hide');
		} else {
			$('#preloader').addClass('hide');
		}
	}
	this.openContextMenu = function (doSelected, id) {
		const selected = _selector.getSelectedSegments();
		const selectType = _selector.getSelectedPolygonType();
		if (doSelected && selected && selected.length > 0 && (selectType === ElementType.REGION || selectType === ElementType.SEGMENT)) {
			_gui.openContextMenu(doSelected, id);
		} else {
			let polygonType = this.getIDType(id);
			if (polygonType === ElementType.REGION || polygonType === ElementType.SEGMENT) {
				_gui.openContextMenu(doSelected, id);
			}
		}
	}
	this.closeContextMenu = function () {
		_gui.closeContextMenu();
	}
	this.escape = function () {
		_selector.unSelect();
		this.closeContextMenu();
		this.endEditing();
		_gui.closeRegionSettings();
	}
	this.allowToLoadExistingSegmentation = function (allowLoadLocal) {
		_allowLoadLocal = allowLoadLocal;
	}

	this.allowToAutosegment = function (autoSegment) {
		_autoSegment = autoSegment;
	}

	this.isSegmentFixed = function (id) {
		if (!_fixedSegments[_currentPage])
			_fixedSegments[_currentPage] = [];

		let isFixed = ($.inArray(id, _fixedSegments[_currentPage]) !== -1);
		return isFixed;
	}

	this._getRegionByID = function (id) {
		let regionPolygon;
		Object.keys(_settings.regions).some((key) => {
			let region = _settings.regions[key];

			let polygon = region.polygons[id];
			if (polygon) {
				regionPolygon = polygon;
				return true;
			}
		});
		return regionPolygon;
	}

	this.isIDTextRegion = function(id){
		const elementType = this.getIDType(id);
		let type = "Region";
		if(elementType === ElementType.SEGMENT){
			type = _segmentation[_currentPage].segments[id].type;
		}else if(elementType === ElementType.REGION){
			type = this._getRegionByID(id).type;
		}
		return (type !== "ignore" && !type.includes("Region"));
	}

	this.getIDType = function (id) {
		let polygon = _segmentation[_currentPage].segments[id];
		if (polygon) return ElementType.SEGMENT;

		polygon = this._getRegionByID(id);
		if (polygon) return ElementType.REGION;

		polygon = _settings.pages[_currentPage].cuts[id];
		if (polygon) return ElementType.CUT;

		if (this.textlineRegister.hasOwnProperty(id)) return ElementType.TEXTLINE;
	}

	this._getPolygon = function (id) {
		let polygon = _segmentation[_currentPage].segments[id];
		if (polygon) return polygon;

		polygon = this._getRegionByID(id);
		if (polygon) return polygon;

		polygon = _settings.pages[_currentPage].cuts[id];
		if (polygon) return polygon;
	}
}