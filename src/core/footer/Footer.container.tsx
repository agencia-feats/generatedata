import { Dispatch } from 'redux';
import { connect } from 'react-redux';
import Footer, { FooterProps } from './Footer.component';
import { GDLocale } from '../../../types/general';
import * as selectors from '../store/generator/generator.selectors';
import * as mainSelectors from '../store/main/main.selectors';
import * as actions from '../store/generator/generator.actions';
import * as mainActions from '../store/main/main.actions';
import * as generalUtils from '../../utils/generalUtils';

const mapStateToProps = (state: any): Partial<FooterProps> => ({
	i18n: selectors.getCoreI18n(state),
	locale: mainSelectors.getLocale(state),
	scriptVersion: generalUtils.getScriptVersion()
});

const mapDispatchToProps = (dispatch: Dispatch): Partial<FooterProps> => ({
	// @ts-ignore-line
	onChangeLocale: (locale: GDLocale): any => dispatch(mainActions.selectLocale(locale)),
	openExportTypeSettings: (): any => dispatch(actions.toggleExportSettings('exportType')),
	onGenerate: (): any => dispatch(actions.showGenerationPanel())
});

export default connect(
	mapStateToProps,
	mapDispatchToProps
)(Footer);
